"""Browsing and editing the applied tables (the Data step).

Writes run on the app's own connection (the owner of ws_<id>), never through the read-only sandbox. Table and
column names are looked up in the system catalog and only ever reach SQL as sql.Identifier; everything else the
client sends is a bound parameter, sent as text so PostgreSQL itself parses it into the column's type. The
database's constraints decide what is allowed; their errors become messages that name the rule that fired.
"""
import csv
import io
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

import psycopg
import psycopg.rows
from psycopg import sql
from pydantic import BaseModel

from qlens import db
from qlens.design import catalog, proposal
from qlens.design.catalog import ColumnInfo
from qlens.errors import ApiError
from qlens.query.serialize import cell

OPTIONS_LIMIT = 20
LABEL_SEPARATOR = " · "

Value = str | int | float | bool | None


@dataclass(frozen=True)
class Table:
    schema: str
    name: str
    color_index: int
    columns: list[ColumnInfo]
    unique_keys: list[list[str]]
    label_columns: list[str]   # what a foreign key to this table is shown as (its natural key)

    def column(self, name: str) -> ColumnInfo:
        for c in self.columns:
            if c["name"] == name:
                return c
        raise ApiError(422, "unknown_column", f"{self.name} has no column {name!r}.", detail={"column": name})

    @property
    def ident(self) -> sql.Identifier:
        return sql.Identifier(self.schema, self.name)


class RowsOut(BaseModel):
    table: str
    color_index: int
    columns: list[ColumnInfo]
    unique_keys: list[list[str]]
    rows: list[dict[str, Any]]
    # fk column -> {id (as a JSON key) -> label} for the ids on this page.
    fk_labels: dict[str, dict[str, str]]
    total: int
    page: int
    page_size: int


class OptionOut(BaseModel):
    id: int
    label: str


class ChangeOut(BaseModel):
    id: int
    table_name: str
    op: Literal["INSERT", "UPDATE", "DELETE"]
    row_pk: int | None
    before: dict[str, Any] | None
    after: dict[str, Any] | None
    changed_at: str


class ChangesOut(BaseModel):
    # Since the design was last applied; re-applying rebuilds the tables from the sheet and loses these edits.
    edited_rows: int    # distinct rows touched
    change_count: int   # every INSERT, UPDATE and DELETE
    changes: list[ChangeOut]


# ---- the applied tables ---------------------------------------------------------------------------

def _applied(conn: psycopg.Connection, ws_id: int) -> proposal.ProposalOut | None:
    row = conn.execute(
        "SELECT p.id FROM qlens.schema_proposals p JOIN qlens.datasets d ON d.id = p.dataset_id "
        "WHERE d.workspace_id = %s AND p.status = 'applied'", (ws_id,)).fetchone()
    return None if row is None else proposal.get_proposal(conn, row["id"])


def tables(conn: psycopg.Connection, ws_id: int) -> dict[str, Table]:
    """The applied design's tables as they really are in ws_<id> (columns and keys from the catalog)."""
    p = _applied(conn, ws_id)
    if p is None:
        return {}
    designed = {t.name: t for t in p.tables}
    out = {}
    for info in catalog.describe(conn, ws_id, "main").tables:
        t = designed.get(info["name"])
        if t is None:
            continue
        cols = info["columns"]
        pk = [c["name"] for c in cols if c["is_pk"]]
        keys = [i["columns"] for i in info["indexes"] if i["unique"] and i["columns"] != pk]
        plain = {c["name"] for c in cols if c["fk"] is None and not c["is_pk"]}
        label = [n for n in (t.unique_keys[0] if t.unique_keys else []) if n in plain]
        if not label:
            label = [c["name"] for c in cols if c["name"] in plain and c["data_type"] == "text"][:1] or pk
        out[t.name] = Table(db.ws_schema(ws_id, "main"), t.name, info["color_index"], cols, keys, label)
    return out


def table(conn: psycopg.Connection, ws_id: int, name: str) -> tuple[Table, dict[str, Table]]:
    all_ = tables(conn, ws_id)
    if name not in all_:
        raise ApiError(404, "table_not_found", f"There is no applied table called {name!r}.")
    return all_[name], all_


def _label(t: Table, alias: str) -> sql.Composable:
    return sql.SQL("concat_ws({}, {})").format(
        sql.Literal(LABEL_SEPARATOR),
        sql.SQL(", ").join(sql.SQL("{}::text").format(sql.Identifier(alias, c)) for c in t.label_columns))


def _like(q: str) -> str:
    """A contains-pattern for ILIKE in which % and _ typed by the user are literal."""
    return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _labels(conn: psycopg.Connection, ref: Table, ids: list[int]) -> dict[str, str]:
    if not ids:
        return {}
    rows = conn.execute(sql.SQL("SELECT r.id, {} AS label FROM {} r WHERE r.id = ANY (%s)").format(
        _label(ref, "r"), ref.ident), (ids,)).fetchall()
    return {str(r["id"]): r["label"] for r in rows}


# ---- read -----------------------------------------------------------------------------------------

FilterOp = Literal["eq", "contains", "gt", "lt", "empty"]
FILTER_OPS: tuple[str, ...] = ("eq", "contains", "gt", "lt", "empty")
EXPORT_LIMIT = 100_000   # the import limit: a sheet never had more rows than this
RELATED_SAMPLE = 5


@dataclass(frozen=True)
class Filter:
    column: str
    op: FilterOp
    value: str | None = None

    @staticmethod
    def parse(raw: str) -> "Filter":
        """`column:op:value` (`column:empty` takes no value). The value may itself contain colons."""
        parts = raw.split(":", 2)
        if len(parts) < 2 or parts[1] not in FILTER_OPS:
            raise ApiError(422, "invalid_filter",
                           f"A filter is column:op:value with op one of {', '.join(FILTER_OPS)}.",
                           detail={"filter": raw})
        column, op = parts[0], parts[1]
        if op != "empty" and len(parts) < 3:
            raise ApiError(422, "invalid_filter", f"The {op} filter on {column} needs a value.",
                           detail={"filter": raw})
        return Filter(column, op, parts[2] if op != "empty" else None)  # type: ignore[arg-type]


@dataclass(frozen=True)
class _View:
    where: sql.Composable
    params: list[Any]
    order: sql.Composable


def _view(conn: psycopg.Connection, t: Table, all_: dict[str, Table], sort: str | None,
          direction: Literal["asc", "desc"], q: str, filters: list[Filter]) -> _View:
    """WHERE and ORDER BY for what the grid shows: search box, column filters (ANDed) and sort."""
    order: sql.Composable = sql.SQL("t.id DESC" if direction == "desc" else "t.id")
    if sort:
        t.column(sort)
        order = sql.SQL("{} {} NULLS LAST, t.id").format(
            sql.Identifier("t", sort), sql.SQL("DESC" if direction == "desc" else "ASC"))

    conds: list[sql.Composable] = []
    params: list[Any] = []
    if q.strip():
        pattern = _like(q.strip())
        # Text columns, and foreign keys by what they stand for (a fee row is found by its student's name).
        alts: list[sql.Composable] = []
        for c in t.columns:
            if c["fk"] is not None:
                ref = all_.get(c["fk"]["table"])
                if ref is not None:
                    alts.append(sql.SQL("{} IN (SELECT r.id FROM {} r WHERE {} ILIKE %s)").format(
                        sql.Identifier("t", c["name"]), ref.ident, _label(ref, "r")))
                    params.append(pattern)
            elif c["data_type"] == "text":
                alts.append(sql.SQL("{} ILIKE %s").format(sql.Identifier("t", c["name"])))
                params.append(pattern)
        conds.append(sql.SQL("({})").format(sql.SQL(" OR ").join(alts)) if alts else sql.SQL("false"))

    for f in filters:
        c = t.column(f.column)
        col = sql.Identifier("t", f.column)
        ref = all_.get(c["fk"]["table"]) if c["fk"] is not None else None
        if f.op == "empty":
            conds.append(sql.SQL("{} IS NULL").format(col))
        elif f.op == "contains":
            if ref is not None:   # by what the key stands for, as in the search box
                conds.append(sql.SQL("{} IN (SELECT r.id FROM {} r WHERE {} ILIKE %s)").format(
                    col, ref.ident, _label(ref, "r")))
            else:
                conds.append(sql.SQL("{}::text ILIKE %s").format(col))
            params.append(_like(f.value or ""))
        else:
            # Checked up front, so a typo is a clear 422 naming the column rather than a failed query.
            ok = conn.execute("SELECT pg_input_is_valid(%s, %s) AS ok", (f.value, c["data_type"])).fetchone()["ok"]
            if not ok:
                raise ApiError(422, "invalid_filter", f"{f.column}: {f.value!r} is not a valid {c['data_type']}.",
                               detail={"column": f.column, "value": f.value})
            # A bound parameter cast to the column's own type (the type name comes from the catalog).
            conds.append(sql.SQL("{} {} CAST(%s AS {})").format(
                col, sql.SQL({"eq": "=", "gt": ">", "lt": "<"}[f.op]), sql.SQL(c["data_type"])))
            params.append(f.value)

    where = sql.SQL(" AND ").join(conds) if conds else sql.SQL("true")
    return _View(where, params, order)


def _fk_labels(conn: psycopg.Connection, t: Table, all_: dict[str, Table],
               rows: list[dict]) -> dict[str, dict[str, str]]:
    out = {}
    for c in t.columns:
        if c["fk"] is not None and (ref := all_.get(c["fk"]["table"])) is not None:
            out[c["name"]] = _labels(conn, ref, sorted({r[c["name"]] for r in rows} - {None}))
    return out


def list_rows(conn: psycopg.Connection, ws_id: int, name: str, page: int, page_size: int, sort: str | None,
              direction: Literal["asc", "desc"], q: str, filters: list[Filter] | None = None) -> RowsOut:
    t, all_ = table(conn, ws_id, name)
    v = _view(conn, t, all_, sort, direction, q, filters or [])
    total = conn.execute(sql.SQL("SELECT count(*) AS n FROM {} t WHERE {}").format(t.ident, v.where),
                         v.params).fetchone()["n"]
    cols = sql.SQL(", ").join(sql.Identifier("t", c["name"]) for c in t.columns)
    rows = conn.execute(sql.SQL("SELECT {} FROM {} t WHERE {} ORDER BY {} LIMIT %s OFFSET %s").format(
        cols, t.ident, v.where, v.order), [*v.params, page_size, (page - 1) * page_size]).fetchall()
    return RowsOut(table=t.name, color_index=t.color_index, columns=t.columns, unique_keys=t.unique_keys,
                   rows=[_row(r) for r in rows], fk_labels=_fk_labels(conn, t, all_, rows),
                   total=total, page=page, page_size=page_size)


def export_csv(conn: psycopg.Connection, ws_id: int, name: str, sort: str | None,
               direction: Literal["asc", "desc"], q: str, filters: list[Filter]) -> str:
    """The grid's current view, every page of it, as CSV. Each foreign key is followed by its label."""
    t, all_ = table(conn, ws_id, name)
    v = _view(conn, t, all_, sort, direction, q, filters)
    select: list[sql.Composable] = []
    header: list[str] = []
    for c in t.columns:
        select.append(sql.Identifier("t", c["name"]))
        header.append(c["name"])
        if c["fk"] is not None and (ref := all_.get(c["fk"]["table"])) is not None:
            select.append(sql.SQL("(SELECT {} FROM {} r WHERE r.id = {})").format(
                _label(ref, "r"), ref.ident, sql.Identifier("t", c["name"])))
            header.append(f"{c['name']}_label")
    cur = conn.cursor(row_factory=psycopg.rows.tuple_row)
    cur.execute(sql.SQL("SELECT {} FROM {} t WHERE {} ORDER BY {} LIMIT %s").format(
        sql.SQL(", ").join(select), t.ident, v.where, v.order), [*v.params, EXPORT_LIMIT])
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(header)
    for r in cur:
        w.writerow(["" if x is None else cell(x) for x in r])
    return buf.getvalue()


class RelatedOut(BaseModel):
    """Rows of another table whose foreign key points at one row."""
    table: str
    column: str
    color_index: int
    total: int
    columns: list[ColumnInfo]
    rows: list[dict[str, Any]]
    fk_labels: dict[str, dict[str, str]]


def related(conn: psycopg.Connection, ws_id: int, name: str, row_id: int) -> list[RelatedOut]:
    """Who references this row, found from the catalog's foreign keys (a student's fee records)."""
    t, all_ = table(conn, ws_id, name)
    if conn.execute(sql.SQL("SELECT 1 FROM {} WHERE id = %s").format(t.ident), (row_id,)).fetchone() is None:
        raise ApiError(404, "row_not_found", f"{name} has no row with id {row_id}.")
    out = []
    for u in all_.values():
        for c in u.columns:
            if c["fk"] is None or c["fk"]["table"] != t.name:
                continue
            col = sql.Identifier(c["name"])
            total = conn.execute(sql.SQL("SELECT count(*) AS n FROM {} WHERE {} = %s").format(u.ident, col),
                                 (row_id,)).fetchone()["n"]
            if total == 0:
                continue
            # The id, then the referencing column (the one this list is about), then the rest.
            cols = sorted(u.columns, key=lambda x: (not x["is_pk"], x["name"] != c["name"]))
            rows = conn.execute(sql.SQL("SELECT {} FROM {} WHERE {} = %s ORDER BY id LIMIT %s").format(
                sql.SQL(", ").join(sql.Identifier(x["name"]) for x in cols), u.ident, col),
                (row_id, RELATED_SAMPLE)).fetchall()
            out.append(RelatedOut(table=u.name, column=c["name"], color_index=u.color_index, total=total,
                                  columns=cols, rows=[_row(r) for r in rows],
                                  fk_labels=_fk_labels(conn, u, all_, rows)))
    return out


def fk_options(conn: psycopg.Connection, ws_id: int, name: str, column: str, q: str) -> list[OptionOut]:
    """Rows a foreign key may point at, shown by the referenced table's natural key."""
    t, all_ = table(conn, ws_id, name)
    c = t.column(column)
    if c["fk"] is None or c["fk"]["table"] not in all_:
        raise ApiError(422, "not_a_foreign_key", f"{name}.{column} is not a foreign key.")
    ref = all_[c["fk"]["table"]]
    rows = conn.execute(sql.SQL(
        "SELECT id, label FROM (SELECT r.id, {} AS label FROM {} r) o WHERE label ILIKE %s "
        "ORDER BY lower(label), id LIMIT %s").format(_label(ref, "r"), ref.ident),
        (_like(q.strip()), OPTIONS_LIMIT)).fetchall()
    return [OptionOut(**r) for r in rows]


def changes(conn: psycopg.Connection, ws_id: int, limit: int) -> ChangesOut:
    applied = conn.execute(
        "SELECT p.applied_at FROM qlens.schema_proposals p JOIN qlens.datasets d ON d.id = p.dataset_id "
        "WHERE d.workspace_id = %s AND p.status = 'applied'", (ws_id,)).fetchone()
    if applied is None:
        return ChangesOut(edited_rows=0, change_count=0, changes=[])
    since = (ws_id, applied["applied_at"])
    n = conn.execute("SELECT count(DISTINCT (table_name, row_pk)) AS rows, count(*) AS changes "
                     "FROM qlens.row_changes WHERE workspace_id = %s AND changed_at > %s", since).fetchone()
    rows = conn.execute(
        "SELECT id, table_name, op, row_pk, before, after, changed_at FROM qlens.row_changes "
        "WHERE workspace_id = %s AND changed_at > %s ORDER BY changed_at DESC, id DESC LIMIT %s",
        (*since, limit)).fetchall()
    return ChangesOut(edited_rows=n["rows"], change_count=n["changes"], changes=[
        ChangeOut(**{**r, "before": cell(r["before"]), "after": cell(r["after"]),
                     "changed_at": r["changed_at"].isoformat()}) for r in rows])


# ---- write ----------------------------------------------------------------------------------------

def _text(v: Value) -> str | None:
    """As text, so PostgreSQL parses it into the column's type (and rejects what does not fit)."""
    if v is None:
        return None
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def _assignments(t: Table, values: dict[str, Value]) -> list[tuple[str, str | None]]:
    out = []
    for k, v in values.items():
        c = t.column(k)
        if c["is_pk"]:
            raise ApiError(422, "column_not_writable", f"{k} is generated by the database and cannot be set.",
                           detail={"column": k})
        out.append((k, _text(v)))
    return out


def _returning(t: Table) -> sql.Composable:
    return sql.SQL(", ").join(sql.Identifier(c["name"]) for c in t.columns)


def _row(r: dict) -> dict[str, Any]:
    return {k: cell(v) for k, v in r.items()}


def insert_row(conn: psycopg.Connection, ws_id: int, name: str, values: dict[str, Value]) -> dict[str, Any]:
    t, all_ = table(conn, ws_id, name)
    sets = _assignments(t, values)
    if sets:
        stmt = sql.SQL("INSERT INTO {} ({}) VALUES ({}) RETURNING {}").format(
            t.ident, sql.SQL(", ").join(sql.Identifier(k) for k, _ in sets),
            sql.SQL(", ").join(sql.Placeholder() * len(sets)), _returning(t))
    else:
        stmt = sql.SQL("INSERT INTO {} DEFAULT VALUES RETURNING {}").format(t.ident, _returning(t))
    run = lambda: conn.execute(stmt, [v for _, v in sets]).fetchone()  # noqa: E731
    return _row(_guarded(conn, t, all_, "INSERT", None, dict(sets), run))


def update_row(conn: psycopg.Connection, ws_id: int, name: str, row_id: int,
               values: dict[str, Value]) -> dict[str, Any]:
    t, all_ = table(conn, ws_id, name)
    sets = _assignments(t, values)
    if not sets:
        raise ApiError(422, "nothing_to_update", "Change at least one value.")
    stmt = sql.SQL("UPDATE {} SET {} WHERE id = %s RETURNING {}").format(
        t.ident, sql.SQL(", ").join(sql.SQL("{} = %s").format(sql.Identifier(k)) for k, _ in sets), _returning(t))
    run = lambda: conn.execute(stmt, [*(v for _, v in sets), row_id]).fetchone()  # noqa: E731
    row = _guarded(conn, t, all_, "UPDATE", row_id, dict(sets), run)
    if row is None:
        raise ApiError(404, "row_not_found", f"{name} has no row with id {row_id}.")
    return _row(row)


def delete_row(conn: psycopg.Connection, ws_id: int, name: str, row_id: int) -> None:
    t, all_ = table(conn, ws_id, name)
    stmt = sql.SQL("DELETE FROM {} WHERE id = %s RETURNING id").format(t.ident)
    if _guarded(conn, t, all_, "DELETE", row_id, {}, lambda: conn.execute(stmt, (row_id,)).fetchone()) is None:
        raise ApiError(404, "row_not_found", f"{name} has no row with id {row_id}.")


# ---- constraint errors in plain words -------------------------------------------------------------

Op = Literal["INSERT", "UPDATE", "DELETE"]


def _guarded(conn: psycopg.Connection, t: Table, all_: dict[str, Table], op: Op, row_id: int | None,
             values: dict[str, str | None], run: Callable[[], Any]) -> Any:
    try:
        # A savepoint: after a failure the request's transaction is still usable to explain it.
        with conn.transaction():
            return run()
    except (psycopg.errors.IntegrityError, psycopg.errors.DataError) as e:
        raise _explain(conn, t, all_, op, row_id, values, e) from None


def _singular(name: str) -> str:
    word = name.replace("_", " ")
    if word.endswith("ies"):
        return word[:-3] + "y"
    if word.endswith(("ches", "shes", "sses", "xes")):
        return word[:-2]
    if word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def _words(name: str) -> str:
    return name.replace("_", " ")


def _a(noun: str) -> str:
    return ("An " if noun[:1].lower() in "aeiou" else "A ") + noun


def _constraint(conn: psycopg.Connection, schema: str, name: str | None) -> dict | None:
    if not name:
        return None
    return conn.execute(
        """SELECT k.conname AS name, t.relname AS table, r.relname AS ref_table,
                  ARRAY(SELECT a.attname FROM unnest(k.conkey) WITH ORDINALITY AS u (attnum, n)
                        JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum
                        ORDER BY u.n) AS columns,
                  pg_get_constraintdef(k.oid, true) AS definition
           FROM pg_constraint k JOIN pg_class t ON t.oid = k.conrelid LEFT JOIN pg_class r ON r.oid = k.confrelid
           WHERE k.connamespace = %s::regnamespace AND k.conname = %s
           ORDER BY k.oid LIMIT 1""", (schema, name)).fetchone()


def _shown(conn: psycopg.Connection, t: Table, all_: dict[str, Table], column: str, value: Any) -> str:
    """A value as a person would name it: a foreign key by its referenced row's label."""
    fk = t.column(column)["fk"]
    if fk is not None and value is not None and fk["table"] in all_:
        try:
            label = _labels(conn, all_[fk["table"]], [int(value)]).get(str(value))
        except ValueError:
            label = None
        if label is not None:
            return f"{_singular(fk['table'])} {label}"
    return f"{column} {value}"


def _explain(conn: psycopg.Connection, t: Table, all_: dict[str, Table], op: Op, row_id: int | None,
             values: dict[str, str | None], e: psycopg.Error) -> ApiError:
    state = e.diag.sqlstate or ""
    server = e.diag.message_primary or str(e)
    k = _constraint(conn, t.schema, e.diag.constraint_name)
    detail: dict[str, Any] = {"sqlstate": state, "constraint": k["name"] if k else e.diag.constraint_name,
                              "columns": list(k["columns"]) if k else [], "table": t.name, "operation": op,
                              # the rule as PostgreSQL prints it, e.g. FOREIGN KEY (student_id) REFERENCES ...
                              "definition": k["definition"] if k else None, "server_message": server}

    def attempted() -> dict[str, Any]:
        # What the row would have been: the stored row (an update) with the submitted values on top.
        current = {}
        if row_id is not None:
            current = conn.execute(sql.SQL("SELECT {} FROM {} WHERE id = %s").format(_returning(t), t.ident),
                                   (row_id,)).fetchone() or {}
        return {**current, **values}

    if state == "23505":
        row = attempted()
        cols = detail["columns"]
        named = {"name", _singular(t.name).replace(" ", "_")}
        if len(cols) == 1 and (cols[0] in named or cols[0].endswith("_name")):
            message = f"{_a(_singular(t.name))} named {row.get(cols[0])} already exists."
        else:
            parts = " and ".join(_shown(conn, t, all_, c, row.get(c)) for c in cols)
            message = f"{_a(_singular(t.name))} with {parts} already exists."
        return ApiError(409, "unique_violation", message, detail={**detail, "kind": "unique"})

    # 23001: ON DELETE RESTRICT (the generated foreign keys); 23503: any other foreign key failure.
    if state in ("23503", "23001"):
        detail["kind"] = "foreign_key"
        if op == "DELETE" and k is not None:
            # This row is the referenced one: count who still points at it.
            child = sql.Identifier(t.schema, k["table"])
            n = conn.execute(sql.SQL("SELECT count(*) AS n FROM {} WHERE {} = %s").format(
                child, sql.Identifier(k["columns"][0])), (row_id,)).fetchone()["n"]
            rows = "record" if n == 1 else "records"
            message = (f"This {_singular(t.name)} is referenced by {n} {_words(k['table'])} {rows}; "
                       "delete or reassign them first.")
            return ApiError(409, "foreign_key_violation", message, detail={
                **detail, "referencing_table": k["table"], "referencing_rows": n})
        ref = k["ref_table"] if k else None
        col = detail["columns"][0] if detail["columns"] else None
        value = values.get(col) if col else None
        noun = _singular(ref) if ref else "referenced row"
        message = f"No such {noun}: {ref or 'the referenced table'} has no row with id {value}."
        return ApiError(409, "foreign_key_violation", message, detail={**detail, "referenced_table": ref})

    if state == "23502":
        col = e.diag.column_name
        detail.update(kind="not_null", columns=[col] if col else [], definition=f"NOT NULL {col}" if col else None)
        return ApiError(422, "not_null_violation", f"{col} cannot be empty: the column is NOT NULL.", detail=detail)

    if state == "23514":
        rule = k["definition"] if k else "a CHECK constraint"
        return ApiError(422, "check_violation", f"The new values break the rule {rule}.",
                        detail={**detail, "kind": "check"})

    if state.startswith("22"):
        # PostgreSQL does not say which value it could not read; ask it about each one.
        bad = [c for c, v in values.items() if v is not None and not conn.execute(
            "SELECT pg_input_is_valid(%s, %s) AS ok", (v, t.column(c)["data_type"])).fetchone()["ok"]]
        detail.update(kind="invalid_input", columns=bad[:1])
        message = f"{bad[0]}: {server}" if bad else server
        return ApiError(422, "invalid_input", message, detail=detail)

    return ApiError(409, "constraint_violation", server, detail={**detail, "kind": "other"})
