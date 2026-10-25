"""The SQL that builds a proposal: tables, data loads, the original_sheet view and the lossless check.

Nothing here runs the SQL (applying is a separate step). Every identifier is a psycopg sql.Identifier, so
the executed statements quote everything; as_text prints the same statements quoted only where needed.
"""
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

import psycopg
from psycopg import sql
from psycopg.rows import tuple_row

from qlens import db
from qlens.design import naming
from qlens.design.proposal import VIEW_NAME, ProposalOut, ProposedColumnOut, TableOut

_TYPES = {"bigint", "numeric", "boolean", "date", "text"}


class _ID(sql.Identifier):
    """A (possibly schema-qualified) identifier that keeps its plain name parts, so as_text can quote them
    only where needed. Executed statements quote it like any sql.Identifier."""

    def __init__(self, *names: str):
        super().__init__(*names)
        self.names = names


@dataclass(frozen=True)
class SqlStep:
    kind: Literal["schema", "table", "insert", "view", "verify"]
    title: str
    sql: sql.Composed


def _pk(t: TableOut) -> str:
    return next(c.name for c in t.columns if c.role == "pk")


def _fks(t: TableOut) -> list[ProposedColumnOut]:
    return [c for c in t.columns if c.role == "fk"]


def _dependency_order(tables: Sequence[TableOut]) -> list[TableOut]:
    """Referenced tables before the tables that point at them; otherwise in proposal order."""
    by_id = {t.id: t for t in tables}
    state: dict[int, str] = {}
    out: list[TableOut] = []

    def visit(t: TableOut) -> None:
        if state.get(t.id) == "done":
            return
        if state.get(t.id) == "visiting":
            raise ValueError(f"foreign keys form a cycle through {t.name}")
        state[t.id] = "visiting"
        for c in _fks(t):
            visit(by_id[c.references_table_id])
        state[t.id] = "done"
        out.append(t)

    for t in tables:
        visit(t)
    return out


class _ConstraintNames:
    """Postgres-style names (<table>_<cols>_key / _fkey), unique in the schema and at most 63 characters."""

    def __init__(self, taken: set[str]):
        self.taken = set(taken)

    def make(self, table: str, columns: list[str], suffix: str) -> str:
        base, n = f"{table}_{'_'.join(columns)}", 1
        while True:
            tail = f"_{suffix}" + (str(n) if n > 1 else "")
            name = base[:naming.MAX_IDENT - len(tail)] + tail
            if name not in self.taken:
                self.taken.add(name)
                return name
            n += 1


def _create_table(t: TableOut, main: str, by_id: dict[int, TableOut], names: _ConstraintNames) -> sql.Composed:
    parts: list[sql.Composable] = []
    for c in t.columns:
        if c.role == "pk":
            parts.append(sql.SQL("{} bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY").format(_ID(c.name)))
            continue
        if c.data_type not in _TYPES:
            raise ValueError(f"unknown data type {c.data_type!r}")
        parts.append(sql.SQL("{} {}{}").format(_ID(c.name), sql.SQL(c.data_type),
                                              sql.SQL(" NOT NULL" if c.not_null else "")))
    # NULLS NOT DISTINCT: an empty natural key (no teacher) is one value of the entity, stored once.
    for key in t.unique_keys:
        parts.append(sql.SQL("CONSTRAINT {} UNIQUE NULLS NOT DISTINCT ({})").format(
            _ID(names.make(t.name, key, "key")), sql.SQL(", ").join(map(_ID, key))))
    for c in _fks(t):
        ref = by_id[c.references_table_id]
        parts.append(sql.SQL("CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({}) ON DELETE RESTRICT").format(
            _ID(names.make(t.name, [c.name], "fkey")), _ID(c.name), _ID(main, ref.name), _ID(_pk(ref))))
    return sql.SQL("CREATE TABLE {} (\n    {}\n)").format(_ID(main, t.name), sql.SQL(",\n    ").join(parts))


def _same(table: str, c: ProposedColumnOut, other: sql.Composable) -> sql.Composed:
    """`table.c` matches `other`. Plain `=` where the column has no NULLs, so the planner can hash-join
    (it matters on a 100,000-row sheet); IS NOT DISTINCT FROM where an empty key must match itself."""
    return sql.SQL("{} {} {}").format(_ID(table, c.name), sql.SQL("=" if c.not_null else "IS NOT DISTINCT FROM"),
                                      other)


def _load(t: TableOut, main: str, src: str, by_id: dict[int, TableOut]) -> sql.Composed:
    """INSERT ... SELECT from _staging. A foreign key is found by looking the referenced row up by its
    natural key, taken from the same staging row."""
    s = naming.unique_name("s", {x.name for x in by_id.values()})
    joins: list[sql.Composable] = []
    joined: set[int] = set()

    def lookup(table_id: int) -> str:
        ref = by_id[table_id]
        if table_id not in joined:
            if not ref.unique_keys:
                raise ValueError(f"{ref.name} has no natural key to look its rows up by")
            cols = {c.name: c for c in ref.columns}
            conds = [_same(ref.name, cols[n], value(cols[n])) for n in ref.unique_keys[0]]
            joins.append(sql.SQL("LEFT JOIN {} ON {}").format(_ID(main, ref.name), sql.SQL(" AND ").join(conds)))
            joined.add(table_id)
        return ref.name

    def value(c: ProposedColumnOut) -> sql.Composable:
        if c.role == "fk":
            # Join the referenced table first (it is appended before the join that uses it).
            ref = by_id[c.references_table_id]
            return _ID(lookup(ref.id), _pk(ref))
        if c.source_column is None:
            raise ValueError(f"column {c.name} has no spreadsheet column to load from")
        return _ID(s, c.source_column)

    cols = [c for c in t.columns if c.role != "pk"]
    values = [value(c) for c in cols]
    fact = t.kind == "fact"
    return sql.SQL("INSERT INTO {} ({})\nSELECT {}{}\nFROM {} {}{}\nORDER BY {}").format(
        _ID(main, t.name), sql.SQL(", ").join(_ID(c.name) for c in cols),
        sql.SQL("" if fact else "DISTINCT "), sql.SQL(", ").join(values),
        _ID(src, "_staging"), _ID(s), sql.SQL("").join(sql.SQL("\n") + j for j in joins),
        # The fact keeps every sheet row, in sheet order; entities get a stable order, so ids repeat on re-apply.
        _ID(s, "_row_id") if fact else sql.SQL(", ").join(sql.SQL(str(i)) for i in range(1, len(cols) + 1)))


def _view(p: ProposalOut, main: str) -> sql.Composed:
    """original_sheet: the fact joined out along its foreign keys, giving back every sheet column."""
    by_id = {t.id: t for t in p.tables}
    fact = next(t for t in p.tables if t.kind == "fact")
    reached: set[int] = set()
    joins: list[sql.Composable] = []
    found: dict[str, tuple[str, str]] = {}          # sheet column -> (table, column) the view reads it from

    def reach(t: TableOut) -> None:
        # Each table is joined once: every path to it lands on the row describing the same sheet row.
        queue = [t]
        reached.add(t.id)
        while queue:
            cur = queue.pop(0)
            for c in cur.columns:
                if c.role == "attribute" and c.source_column is not None:
                    found.setdefault(c.source_column, (cur.name, c.name))
            for c in _fks(cur):
                ref = by_id[c.references_table_id]
                if ref.id not in reached:
                    reached.add(ref.id)
                    joins.append(sql.SQL("LEFT JOIN {} ON {} = {}").format(
                        _ID(main, ref.name), _ID(ref.name, _pk(ref)), _ID(cur.name, c.name)))
                    queue.append(ref)

    def natural_key_join(t: TableOut) -> sql.Composable | None:
        """Join t on its natural key from values already in the view, if they all are."""
        cols = {c.name: c for c in t.columns}
        conds = []
        for n in t.unique_keys[0]:
            c = cols[n]
            if c.role == "fk" and c.references_table_id in reached:
                ref = by_id[c.references_table_id]
                other = _ID(ref.name, _pk(ref))
            elif c.role == "attribute" and c.source_column in found:
                other = _ID(*found[c.source_column])
            else:
                return None
            conds.append(_same(t.name, c, other))
        return sql.SQL("LEFT JOIN {} ON {}").format(_ID(main, t.name), sql.SQL(" AND ").join(conds))

    reach(fact)
    # A table no foreign key leads to (its key spans columns of several tables) is joined on its
    # natural key instead.
    while missing := [s for s in p.source_columns if s not in found]:
        for t in p.tables:
            if (t.id not in reached and t.unique_keys and any(c.source_column in missing for c in t.columns)
                    and (join := natural_key_join(t)) is not None):
                joins.append(join)
                reach(t)
                break
        else:
            raise ValueError(f"the design cannot rebuild column(s) {', '.join(missing)}")

    select = [_ID(*found[s]) if found[s][1] == s else sql.SQL("{} AS {}").format(_ID(*found[s]), _ID(s))
              for s in p.source_columns]
    return sql.SQL("CREATE VIEW {} AS\nSELECT {}\nFROM {}{}").format(
        _ID(main, VIEW_NAME), sql.SQL(",\n       ").join(select), _ID(main, fact.name),
        sql.SQL("").join(sql.SQL("\n") + j for j in joins))


def _verify(p: ProposalOut, main: str, src: str) -> sql.Composed:
    """Both EXCEPT ALL differences must be empty: the view gives back exactly the staging rows, repeats
    included (_row_id is not a sheet column, so it is left out)."""
    cols = sql.SQL(", ").join(map(_ID, p.source_columns))
    view, staging = _ID(main, VIEW_NAME), _ID(src, "_staging")
    return sql.SQL(
        "SELECT (SELECT count(*) FROM {staging}) AS staging_rows,\n"
        "       (SELECT count(*) FROM {view}) AS reconstructed_rows,\n"
        "       (SELECT count(*) FROM (SELECT {cols} FROM {view}\n"
        "                              EXCEPT ALL SELECT {cols} FROM {staging}) d) AS extra_rows,\n"
        "       (SELECT count(*) FROM (SELECT {cols} FROM {staging}\n"
        "                              EXCEPT ALL SELECT {cols} FROM {view}) d) AS missing_rows"
    ).format(staging=staging, view=view, cols=cols)


def render(proposal: ProposalOut, ws_id: int) -> list[SqlStep]:
    """The statements that build the proposal in schema ws_<id>, in the order they must run."""
    main, src = db.ws_schema(ws_id, "main"), db.ws_schema(ws_id, "src")
    by_id = {t.id: t for t in proposal.tables}
    order = _dependency_order(proposal.tables)
    names = _ConstraintNames({t.name for t in proposal.tables} | {VIEW_NAME})
    return [
        SqlStep("schema", f"Create schema {main}", sql.SQL("CREATE SCHEMA IF NOT EXISTS {}").format(_ID(main))),
        *[SqlStep("table", f"Create table {t.name}", _create_table(t, main, by_id, names)) for t in order],
        *[SqlStep("insert", f"Load {t.name}", _load(t, main, src, by_id)) for t in order],
        SqlStep("view", f"Create view {VIEW_NAME}", _view(proposal, main)),
        SqlStep("verify", "Check that the original sheet comes back unchanged", _verify(proposal, main, src)),
    ]


# ---- readable text --------------------------------------------------------------------------------

def _identifiers(part: sql.Composable, out: set[str]) -> None:
    if isinstance(part, _ID):
        out.update(part.names)
    elif isinstance(part, sql.Composed):
        for p in part:
            _identifiers(p, out)


def as_text(steps: Sequence[SqlStep], conn: psycopg.Connection) -> str:
    """The script as a person would write it: each statement after a `-- <title>` comment, identifiers
    quoted only where PostgreSQL needs it (quote_ident decides: upper case, spaces, reserved words)."""
    names: set[str] = set()
    for step in steps:
        _identifiers(step.sql, names)
    with conn.cursor(row_factory=tuple_row) as cur:
        quoted = dict(cur.execute("SELECT n, quote_ident(n) FROM unnest(%s::text[]) AS n", (sorted(names),)))

    def text(part: sql.Composable) -> str:
        if isinstance(part, _ID):
            return ".".join(quoted[n] for n in part.names)
        if isinstance(part, sql.Composed):
            return "".join(text(p) for p in part)
        return part.as_string(conn)

    return "\n\n".join(f"-- {step.title}\n{text(step.sql)};" for step in steps) + "\n"
