"""The proposed 3NF design: synthesized relations become tables with surrogate keys and foreign keys.

A relation that holds an entity's natural key (its determinant, or a column set equivalent to it) does not
repeat those columns: it stores `<entity>_id` instead. The design is stored in qlens.proposed_* so the
user can rename tables and columns before it is applied; ddl.render turns it into SQL.
"""
from dataclasses import dataclass
from typing import Literal

import psycopg
from pydantic import BaseModel

from qlens.analysis import discover
from qlens.analysis.fd_algebra import Relation, synthesize_3nf
from qlens.design import naming
from qlens.errors import ApiError

N_COLORS = 8
# The view that rebuilds the original sheet lives next to the tables, so no table may take its name.
VIEW_NAME = "original_sheet"
_PG_TYPE = {"integer": "bigint", "numeric": "numeric", "boolean": "boolean", "date": "date", "text": "text"}


class ProposedColumnOut(BaseModel):
    id: int
    name: str
    data_type: str
    role: Literal["pk", "fk", "attribute"]
    not_null: bool
    references_table_id: int | None
    # The spreadsheet column an attribute holds (its name in _staging); None for id and foreign keys.
    source_column: str | None
    # The spreadsheet header behind the column; for a foreign key, that of the natural key it stands for.
    source_label: str | None


class TableOut(BaseModel):
    id: int
    name: str
    kind: Literal["entity", "fact"]
    color_index: int
    explanation: str
    columns: list[ProposedColumnOut]
    # For an entity the first key is its natural key (the determinant behind the surrogate id).
    unique_keys: list[list[str]]


class ProposalOut(BaseModel):
    id: int
    status: Literal["draft", "applied", "superseded"]
    lossless_ok: bool | None
    # Every column of the original sheet, in sheet order (what original_sheet must give back).
    source_columns: list[str]
    tables: list[TableOut]


# ---- planning (pure) ------------------------------------------------------------------------------

@dataclass
class _Col:
    name: str
    role: str
    data_type: str
    not_null: bool
    position: int                 # sheet ordinal of the (first) column it holds; orders the columns
    source: str | None = None     # attribute: the spreadsheet column
    ref: int | None = None        # foreign key: index of the referenced table in the plan
    holds: tuple[str, ...] = ()   # foreign key: the spreadsheet columns it replaces


@dataclass
class _Table:
    name: str
    kind: str
    explanation: str
    columns: list[_Col]
    keys: list[list[str]]


def _and(items: list[str]) -> str:
    return items[0] if len(items) == 1 else f"{', '.join(items[:-1])} and {items[-1]}"


def _fact_explanation(key_labels: list[str], refs: list[str]) -> str:
    text = "One row per original sheet row"
    if key_labels:
        text += f", identified by {' + '.join(key_labels)}"
    text += "."
    if refs:
        text += f" It points to {_and(refs)} instead of repeating their details."
    return text


def _plan(relations: list[Relation], cols: list[dict], keys: list[tuple[str, ...]], filename: str) -> list[_Table]:
    info = {c["name"]: c for c in cols}
    ordinal = {c["name"]: i for i, c in enumerate(cols)}
    key_sets = {frozenset(k) for k in keys}
    entities = [r for r in relations if not r.is_fact]
    fact = next(r for r in relations if r.is_fact)

    taken = {VIEW_NAME}
    names, singulars = [], []
    for r in entities:
        plural, singular = naming.entity_name(r.determinant)
        names.append(naming.unique_name(plural, taken))
        singulars.append(singular)
        taken.add(names[-1])
    names.append(naming.unique_name(naming.fact_name(filename), taken))

    def label(a: str) -> str:
        return info[a]["label"]

    plan: list[_Table] = []
    for i, r in enumerate([*entities, fact]):
        attrs = set(r.attributes)
        # Entities whose natural key (or an equivalent one) sits in this relation; the biggest first, so
        # that a composite key wins over an entity keyed by part of it.
        matches = []
        for j, e in enumerate(entities):
            if e is r:
                continue
            hit = [set(k) for k in [e.determinant, *e.equivalents] if set(k) <= attrs]
            if hit:
                matches.append((j, set().union(*hit)))
        matches.sort(key=lambda m: (-len(m[1]), m[0]))
        replaced: set[str] = set()
        columns = [_Col("id", "pk", "bigint", True, -1)]
        for j, held in matches:
            if held & replaced:
                continue
            replaced |= held
            columns.append(_Col(f"{singulars[j]}_id", "fk", "bigint",
                                all(info[a]["null_count"] == 0 for a in held),
                                min(ordinal[a] for a in held), ref=j, holds=tuple(held)))
        for a in r.attributes:
            if a not in replaced:
                columns.append(_Col(a, "attribute", _PG_TYPE[info[a]["inferred_type"]],
                                    info[a]["null_count"] == 0, ordinal[a], source=a))
        columns.sort(key=lambda c: c.position)

        held_by: dict[str, str] = {}               # sheet column -> the table column that carries it
        used: set[str] = set()
        for c in columns:
            c.name = naming.unique_name(c.name, used)
            used.add(c.name)
            held_by.update({a: c.name for a in c.holds})
            if c.source is not None:
                held_by[c.source] = c.name

        position = {c.name: n for n, c in enumerate(columns)}

        def as_columns(sheet_cols) -> list[str]:
            return sorted({held_by[a] for a in sheet_cols}, key=position.__getitem__)

        if r.is_fact:
            # A natural key only when the data proved it unique (a stored candidate key).
            tkeys = [as_columns(r.determinant)] if r.determinant and frozenset(r.determinant) in key_sets else []
            text = _fact_explanation([label(a) for a in r.determinant] if tkeys else [],
                                     [names[c.ref] for c in columns if c.role == "fk"])
        else:
            tkeys = []
            for k in [r.determinant, *r.equivalents]:
                if (mapped := as_columns(k)) not in tkeys:
                    tkeys.append(mapped)
            rest = [label(a) for a in r.attributes if a not in r.determinant]
            text = (f"Each {' + '.join(label(a) for a in r.determinant)} has one {_and(rest)}, "
                    "so they are stored once here instead of on every row.")
        plan.append(_Table(names[i], "fact" if r.is_fact else "entity", text, columns, tkeys))
    return plan


# ---- build and store ------------------------------------------------------------------------------

def _keys(conn: psycopg.Connection, dataset_id: int) -> list[tuple[str, ...]]:
    """Stored candidate keys, smallest first, then in column order."""
    rows = conn.execute(
        "SELECT array_agg(c.name ORDER BY c.ordinal) AS cols FROM qlens.candidate_keys k "
        "JOIN qlens.candidate_key_columns kc ON kc.key_id = k.id JOIN qlens.dataset_columns c ON c.id = kc.column_id "
        "WHERE k.dataset_id = %s GROUP BY k.id ORDER BY k.key_size, array_agg(c.ordinal ORDER BY c.ordinal)",
        (dataset_id,)).fetchall()
    return [tuple(r["cols"]) for r in rows]


def build(conn: psycopg.Connection, dataset_id: int) -> ProposalOut:
    """Synthesize a fresh draft from the exact, accepted dependencies; it replaces the current draft.

    An applied proposal stays applied (its tables still exist) until a newer one is applied."""
    ds = conn.execute("SELECT original_filename, status FROM qlens.datasets WHERE id = %s", (dataset_id,)).fetchone()
    if ds is None:
        raise ApiError(404, "no_dataset", "This workspace has no dataset yet.")
    if ds["status"] == "imported":
        raise ApiError(409, "not_analyzed", "Analyze the dataset before designing tables.")
    cols = conn.execute(
        "SELECT id, name, label, inferred_type, null_count FROM qlens.dataset_columns WHERE dataset_id = %s "
        "ORDER BY ordinal", (dataset_id,)).fetchall()
    keys = _keys(conn, dataset_id)
    fds = discover.to_algebra(discover.load_fds(conn, dataset_id))
    relations = synthesize_3nf([c["name"] for c in cols], fds, [frozenset(k) for k in keys])
    plan = _plan(relations, cols, keys, ds["original_filename"])
    column_id = {c["name"]: c["id"] for c in cols}

    with conn.transaction():
        conn.execute("UPDATE qlens.schema_proposals SET status = 'superseded' "
                     "WHERE dataset_id = %s AND status = 'draft'", (dataset_id,))
        pid = conn.execute("INSERT INTO qlens.schema_proposals (dataset_id, status) VALUES (%s, 'draft') "
                           "RETURNING id", (dataset_id,)).fetchone()["id"]
        table_ids = [conn.execute(
            "INSERT INTO qlens.proposed_tables (proposal_id, ordinal, name, kind, color_index, explanation) "
            "VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
            (pid, n, t.name, t.kind, (n - 1) % N_COLORS, t.explanation)).fetchone()["id"]
            for n, t in enumerate(plan, start=1)]
        for t, tid in zip(plan, table_ids):
            ids = {}
            for n, c in enumerate(t.columns, start=1):
                ids[c.name] = conn.execute(
                    "INSERT INTO qlens.proposed_columns (table_id, ordinal, name, source_column_id, data_type, "
                    "role, not_null, references_table_id) VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
                    (tid, n, c.name, column_id.get(c.source), c.data_type, c.role, c.not_null,
                     None if c.ref is None else table_ids[c.ref])).fetchone()["id"]
            for n, key in enumerate(t.keys):
                kid = conn.execute("INSERT INTO qlens.proposed_unique_keys (table_id, is_primary_natural) "
                                   "VALUES (%s, %s) RETURNING id", (tid, n == 0)).fetchone()["id"]
                for name in key:
                    conn.execute("INSERT INTO qlens.proposed_unique_key_columns (key_id, column_id) VALUES (%s, %s)",
                                 (kid, ids[name]))
    return get_proposal(conn, pid)


# ---- read -----------------------------------------------------------------------------------------

def get_proposal(conn: psycopg.Connection, proposal_id: int) -> ProposalOut:
    p = conn.execute("SELECT id, dataset_id, status, lossless_ok FROM qlens.schema_proposals WHERE id = %s",
                     (proposal_id,)).fetchone()
    tables = conn.execute("SELECT id, name, kind, color_index, explanation FROM qlens.proposed_tables "
                          "WHERE proposal_id = %s ORDER BY ordinal", (proposal_id,)).fetchall()
    columns = conn.execute(
        "SELECT c.id, c.table_id, c.name, c.data_type, c.role, c.not_null, c.references_table_id, "
        "       d.name AS source_column, d.label AS source_label "
        "FROM qlens.proposed_columns c JOIN qlens.proposed_tables t ON t.id = c.table_id "
        "LEFT JOIN qlens.dataset_columns d ON d.id = c.source_column_id "
        "WHERE t.proposal_id = %s ORDER BY t.ordinal, c.ordinal", (proposal_id,)).fetchall()
    keys = conn.execute(
        "SELECT k.table_id, array_agg(c.name ORDER BY c.ordinal) AS cols "
        "FROM qlens.proposed_unique_keys k JOIN qlens.proposed_tables t ON t.id = k.table_id "
        "JOIN qlens.proposed_unique_key_columns kc ON kc.key_id = k.id "
        "JOIN qlens.proposed_columns c ON c.id = kc.column_id "
        "WHERE t.proposal_id = %s GROUP BY k.id ORDER BY k.is_primary_natural DESC, k.id",
        (proposal_id,)).fetchall()
    source_columns = [r["name"] for r in conn.execute(
        "SELECT name FROM qlens.dataset_columns WHERE dataset_id = %s ORDER BY ordinal", (p["dataset_id"],))]

    cols_of: dict[int, list[dict]] = {t["id"]: [] for t in tables}
    for c in columns:
        cols_of[c["table_id"]].append(c)
    keys_of: dict[int, list[list[str]]] = {t["id"]: [] for t in tables}
    for k in keys:
        keys_of[k["table_id"]].append(k["cols"])

    def natural_label(table_id: int, seen: frozenset[int] = frozenset()) -> str | None:
        """What a foreign key to this table stands for: the headers of its natural key."""
        if not keys_of[table_id] or table_id in seen:
            return None
        by_name = {c["name"]: c for c in cols_of[table_id]}
        parts = [by_name[n]["source_label"] if by_name[n]["role"] != "fk"
                 else natural_label(by_name[n]["references_table_id"], seen | {table_id})
                 for n in keys_of[table_id][0]]
        return None if None in parts else " + ".join(parts)

    for c in columns:
        if c["role"] == "fk":
            c["source_label"] = natural_label(c["references_table_id"])
    # The fact's explanation names other tables, so it is rendered from their current names (the stored
    # text is the one from build time). Entity explanations use only spreadsheet headers, which renames
    # do not touch, so the stored text stays right.
    name_of = {t["id"]: t["name"] for t in tables}
    for t in tables:
        if t["kind"] == "fact":
            label_of = {c["name"]: c["source_label"] for c in cols_of[t["id"]]}
            t["explanation"] = _fact_explanation(
                [label_of[n] for n in keys_of[t["id"]][0]] if keys_of[t["id"]] else [],
                [name_of[c["references_table_id"]] for c in cols_of[t["id"]] if c["role"] == "fk"])
    return ProposalOut(
        id=p["id"], status=p["status"], lossless_ok=p["lossless_ok"], source_columns=source_columns,
        tables=[TableOut(**t, unique_keys=keys_of[t["id"]],
                         columns=[ProposedColumnOut(**{k: v for k, v in c.items() if k != "table_id"})
                                  for c in cols_of[t["id"]]])
                for t in tables])


def live_proposal(conn: psycopg.Connection, dataset_id: int) -> ProposalOut | None:
    """The draft being edited if there is one, else the applied proposal."""
    row = conn.execute("SELECT id FROM qlens.schema_proposals WHERE dataset_id = %s AND status <> 'superseded' "
                       "ORDER BY status = 'draft' DESC LIMIT 1", (dataset_id,)).fetchone()
    return None if row is None else get_proposal(conn, row["id"])


# ---- renames --------------------------------------------------------------------------------------

def _check_identifier(name: str) -> None:
    if not naming.valid_identifier(name):
        raise ApiError(422, "invalid_identifier",
                       "Use lower-case letters, digits and underscores, starting with a letter (at most 63).")


def _check_draft(status: str) -> None:
    # An applied proposal describes tables that exist; renaming it would make the two disagree.
    if status != "draft":
        raise ApiError(409, "proposal_not_draft", "Only the current draft can be renamed; build a new design first.")


def rename_table(conn: psycopg.Connection, dataset_id: int, table_id: int, name: str) -> ProposalOut:
    _check_identifier(name)
    t = conn.execute(
        "SELECT t.id, t.proposal_id, p.status FROM qlens.proposed_tables t "
        "JOIN qlens.schema_proposals p ON p.id = t.proposal_id "
        "WHERE t.id = %s AND p.dataset_id = %s FOR UPDATE OF t",
        (table_id, dataset_id)).fetchone()
    if t is None:
        raise ApiError(404, "table_not_found", "Table not found.")
    _check_draft(t["status"])
    clash = conn.execute("SELECT 1 FROM qlens.proposed_tables WHERE proposal_id = %s AND name = %s AND id <> %s",
                         (t["proposal_id"], name, table_id)).fetchone()
    if clash is not None or name == VIEW_NAME:
        raise ApiError(409, "name_taken", f"There is already a table called {name}.")
    conn.execute("UPDATE qlens.proposed_tables SET name = %s WHERE id = %s", (name, table_id))
    return get_proposal(conn, t["proposal_id"])


def rename_column(conn: psycopg.Connection, dataset_id: int, column_id: int, name: str) -> ProposalOut:
    _check_identifier(name)
    c = conn.execute(
        "SELECT c.id, c.table_id, t.proposal_id, p.status FROM qlens.proposed_columns c "
        "JOIN qlens.proposed_tables t ON t.id = c.table_id JOIN qlens.schema_proposals p ON p.id = t.proposal_id "
        "WHERE c.id = %s AND p.dataset_id = %s FOR UPDATE OF c",
        (column_id, dataset_id)).fetchone()
    if c is None:
        raise ApiError(404, "column_not_found", "Column not found.")
    _check_draft(c["status"])
    clash = conn.execute("SELECT 1 FROM qlens.proposed_columns WHERE table_id = %s AND name = %s AND id <> %s",
                         (c["table_id"], name, column_id)).fetchone()
    if clash is not None:
        raise ApiError(409, "name_taken", f"This table already has a column called {name}.")
    conn.execute("UPDATE qlens.proposed_columns SET name = %s WHERE id = %s", (name, column_id))
    return get_proposal(conn, c["proposal_id"])
