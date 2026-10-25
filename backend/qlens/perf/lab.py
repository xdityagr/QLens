"""The performance lab: ws_<id>_lab, a scratch copy of the applied tables to scale up and index freely.

The copy keeps only each table's primary key (no unique, foreign-key or secondary indexes), so the index advisor
has room to suggest something. LIKE copies no triggers, so neither the copy nor scaling ever fires the audit
triggers of the real tables. The scale factor so far is kept as the schema's comment.

Queries and timing runs go through the sandbox (the workspace role, its own connection), so whatever the sandbox
must see is committed first: these functions commit `conn` where they say so.
"""
import re
import statistics
from datetime import datetime
from typing import TypedDict

import psycopg
from psycopg import sql
from pydantic import BaseModel

from qlens import db
from qlens.design import catalog
from qlens.errors import ApiError
from qlens.perf import advisor
from qlens.perf.explain import PlanOut, parse_plan
from qlens.query import sandbox
from qlens.query.validate import validate_select

MIN_FACTOR, MAX_FACTOR = 2, 200
MAX_FACT_ROWS = 500_000
MAX_RUNS = 10
_SCALE_COMMENT = re.compile(r"scale_factor=(\d+)")


class LabIndex(TypedDict):
    name: str
    columns: list[str]


class LabTable(TypedDict):
    name: str
    color_index: int
    row_count: int
    indexes: list[LabIndex]


class LabOut(BaseModel):
    tables: list[LabTable]
    scale_factor: int


class ExperimentRow(BaseModel):
    id: int
    table: str
    columns: list[str]
    index_name: str
    ddl: str
    before_ms: float
    after_ms: float
    speedup: float | None
    runs: int
    status: str
    created_at: datetime


class ExperimentOut(ExperimentRow):
    before_plan: PlanOut
    after_plan: PlanOut


def _lab(ws_id: int) -> str:
    return db.ws_schema(ws_id, "lab")


def _lock(conn: psycopg.Connection, ws_id: int) -> None:
    # Serialises lab changes per workspace. NO KEY UPDATE, so inserts that reference the workspace
    # (query runs, snapshots) are not blocked meanwhile.
    conn.execute("SELECT 1 FROM qlens.workspaces WHERE id = %s FOR NO KEY UPDATE", (ws_id,))


def _exists(conn: psycopg.Connection, ws_id: int) -> bool:
    return conn.execute("SELECT 1 FROM pg_namespace WHERE nspname = %s", (_lab(ws_id),)).fetchone() is not None


def _scale_factor(conn: psycopg.Connection, ws_id: int) -> int:
    row = conn.execute("SELECT obj_description(oid, 'pg_namespace') AS c FROM pg_namespace WHERE nspname = %s",
                       (_lab(ws_id),)).fetchone()
    m = _SCALE_COMMENT.search((row or {}).get("c") or "")
    return int(m.group(1)) if m else 1


def _set_scale_factor(conn: psycopg.Connection, ws_id: int, factor: int) -> None:
    conn.execute(sql.SQL("COMMENT ON SCHEMA {} IS {}").format(
        sql.Identifier(_lab(ws_id)), sql.Literal(f"QLens performance lab, scale_factor={factor}")))


def status(conn: psycopg.Connection, ws_id: int) -> LabOut:
    """The lab as it is now; no tables (and factor 1) when it has not been built."""
    if not _exists(conn, ws_id):
        return LabOut(tables=[], scale_factor=1)
    tables = [LabTable(name=t["name"], color_index=t["color_index"], row_count=t["row_count"],
                       indexes=[LabIndex(name=i["name"], columns=i["columns"]) for i in t["indexes"]])
              for t in catalog.describe(conn, ws_id, "lab").tables]
    return LabOut(tables=tables, scale_factor=_scale_factor(conn, ws_id))


def _applied_tables(conn: psycopg.Connection, ws_id: int) -> list[dict]:
    rows = conn.execute(
        "SELECT t.name, t.kind FROM qlens.proposed_tables t JOIN qlens.schema_proposals p ON p.id = t.proposal_id "
        "JOIN qlens.datasets d ON d.id = p.dataset_id WHERE d.workspace_id = %s AND p.status = 'applied' "
        "ORDER BY t.ordinal", (ws_id,)).fetchall()
    if not rows:
        raise ApiError(409, "not_applied", "Apply a design first: the lab is a copy of the applied tables.")
    return rows


def _primary_key(conn: psycopg.Connection, schema: str, table: str) -> list[str]:
    return [r["attname"] for r in conn.execute(
        "SELECT a.attname FROM pg_constraint k CROSS JOIN LATERAL unnest(k.conkey) WITH ORDINALITY AS u (attnum, n) "
        "JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum "
        "WHERE k.conrelid = to_regclass(format('%%I.%%I', %s::text, %s::text)) AND k.contype = 'p' ORDER BY u.n",
        (schema, table)).fetchall()]


def ensure_lab(conn: psycopg.Connection, ws_id: int) -> LabOut:
    """Build the lab from the applied tables unless it exists. Commits `conn` when it builds the lab."""
    _lock(conn, ws_id)
    if _exists(conn, ws_id):
        return status(conn, ws_id)
    tables = _applied_tables(conn, ws_id)
    main, lab = db.ws_schema(ws_id, "main"), _lab(ws_id)
    # Indexes of an earlier lab went with it.
    conn.execute("UPDATE qlens.index_experiments SET status = 'dropped' WHERE workspace_id = %s AND status = 'kept'",
                 (ws_id,))
    db.create_ws_schema(conn, ws_id, "lab")
    for t in tables:
        src, dst = sql.Identifier(main, t["name"]), sql.Identifier(lab, t["name"])
        conn.execute(sql.SQL("CREATE TABLE {} (LIKE {} INCLUDING DEFAULTS INCLUDING IDENTITY)").format(dst, src))
        pk = _primary_key(conn, main, t["name"])
        if pk:
            conn.execute(sql.SQL("ALTER TABLE {} ADD PRIMARY KEY ({})").format(
                dst, sql.SQL(", ").join(map(sql.Identifier, pk))))
        conn.execute(sql.SQL("INSERT INTO {} OVERRIDING SYSTEM VALUE SELECT * FROM {}").format(dst, src))
        if len(pk) == 1:
            # The copied identity starts again at 1; new rows must continue after the copied ids.
            conn.execute(sql.SQL(
                "SELECT setval(seq, coalesce((SELECT max({pk}) FROM {dst}), 0) + 1, false) "
                "FROM pg_get_serial_sequence({name}, {col}) AS seq WHERE seq IS NOT NULL").format(
                pk=sql.Identifier(pk[0]), dst=dst, name=sql.Literal(dst.as_string(conn)), col=sql.Literal(pk[0])))
    # Default privileges already cover tables made here; explicit all the same.
    conn.execute(sql.SQL("GRANT SELECT ON ALL TABLES IN SCHEMA {} TO {}").format(
        sql.Identifier(lab), sql.Identifier(db.ws_role(ws_id))))
    _set_scale_factor(conn, ws_id, 1)
    for t in tables:
        conn.execute(sql.SQL("ANALYZE {}").format(sql.Identifier(lab, t["name"])))
    out = status(conn, ws_id)
    conn.commit()
    return out


def reset_lab(conn: psycopg.Connection, ws_id: int) -> LabOut:
    """Drop the lab and build it again from the applied tables (commits, as ensure_lab)."""
    _lock(conn, ws_id)
    db.drop_ws_schema(conn, ws_id, "lab")
    return ensure_lab(conn, ws_id)


def scale(conn: psycopg.Connection, ws_id: int, factor: int) -> LabOut:
    """Multiply the fact table's rows by `factor` (new ids, same values); the entity tables stay as they are."""
    if not MIN_FACTOR <= factor <= MAX_FACTOR:
        raise ApiError(422, "invalid_factor", f"Choose a scale factor from {MIN_FACTOR} to {MAX_FACTOR}.")
    ensure_lab(conn, ws_id)
    _lock(conn, ws_id)  # again: ensure_lab commits (releasing it) when it builds the lab
    fact = next((t["name"] for t in _applied_tables(conn, ws_id) if t["kind"] == "fact"), None)
    if fact is None:
        raise ApiError(409, "no_fact_table", "The applied design has no fact table to scale.")
    lab = _lab(ws_id)
    table = sql.Identifier(lab, fact)
    rows = conn.execute(sql.SQL("SELECT count(*) AS n FROM {}").format(table)).fetchone()["n"]
    if rows * factor > MAX_FACT_ROWS:
        raise ApiError(422, "scale_too_large",
                       f"{fact} would have {rows * factor:,} rows; the lab allows at most {MAX_FACT_ROWS:,}.",
                       detail={"rows": rows, "factor": factor, "max_rows": MAX_FACT_ROWS})
    pk = set(_primary_key(conn, lab, fact))
    cols = sql.SQL(", ").join(sql.Identifier(c["name"]) for t in catalog.describe(conn, ws_id, "lab").tables
                              if t["name"] == fact for c in t["columns"] if c["name"] not in pk)
    conn.execute(sql.SQL("INSERT INTO {t} ({c}) SELECT {c} FROM {t} CROSS JOIN generate_series(1, {n})").format(
        t=table, c=cols, n=sql.Literal(factor - 1)))
    conn.execute(sql.SQL("ANALYZE {}").format(table))
    _set_scale_factor(conn, ws_id, _scale_factor(conn, ws_id) * factor)
    return status(conn, ws_id)


# ---- index experiments ----------------------------------------------------------------------------

_EXP_COLS = ("id, table_name AS table, columns, index_name, ddl, before_ms::float8 AS before_ms, "
             "after_ms::float8 AS after_ms, speedup::float8 AS speedup, runs, status, created_at")


def _timed(ws_id: int, sql_text: str, runs: int) -> tuple[float, PlanOut]:
    """Median execution time of `runs` EXPLAIN ANALYZE runs in the lab, and the plan of the median run."""
    plans = sorted((parse_plan(d) for d in sandbox.explain_analyze(ws_id, sql_text, target="lab", runs=runs)),
                   key=lambda p: p.execution_ms)
    return statistics.median(p.execution_ms for p in plans), plans[(len(plans) - 1) // 2]


def try_index(conn: psycopg.Connection, ws_id: int, sql_text: str, table: str, columns: list[str],
              runs: int = 5) -> ExperimentOut:
    """Time the query, create the index in the lab, time it again, and record the experiment.

    Commits `conn`: the sandbox must see the index. The workspace lock is held from the checks until the index is
    committed, so a second experiment on the same workspace waits and then finds the index. Raises ApiError for bad
    input and sandbox.QueryError when the query itself fails; any failure after the index was made drops it again.
    """
    sql_text = validate_select(sql_text)
    if not 1 <= len(columns) <= advisor.MAX_COLUMNS or len(set(columns)) != len(columns):
        raise ApiError(422, "invalid_columns", f"Index 1 to {advisor.MAX_COLUMNS} different columns.")
    runs = max(1, min(int(runs), MAX_RUNS))
    ensure_lab(conn, ws_id)
    _lock(conn, ws_id)  # again: ensure_lab commits (releasing it) when it builds the lab
    found = next((t for t in catalog.describe(conn, ws_id, "lab").tables if t["name"] == table), None)
    if found is None:
        raise ApiError(422, "unknown_table", "The lab has no table of that name.")
    names = {c["name"] for c in found["columns"]}
    missing = [c for c in columns if c not in names]
    if missing:
        raise ApiError(422, "unknown_column", f"{table} has no column of that name.", detail={"columns": missing})
    if advisor.covered([i["columns"] for i in found["indexes"]], columns):
        raise ApiError(409, "index_exists", f"An index on {table} already starts with these columns.")
    taken = {r["relname"] for r in conn.execute(
        "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = %s",
        (_lab(ws_id),))}
    suffix = 1
    while (name := advisor.index_name(table, columns, suffix)) in taken:
        suffix += 1
    ddl = advisor.index_ddl(conn, ws_id, name, table, columns)

    before_ms, before_plan = _timed(ws_id, sql_text, runs)
    lab_table = sql.Identifier(_lab(ws_id), table)
    try:
        conn.execute(sql.SQL("CREATE INDEX {} ON {} ({})").format(
            sql.Identifier(name), lab_table, sql.SQL(", ").join(map(sql.Identifier, columns))))
    except psycopg.errors.DuplicateTable:  # the same experiment started twice at once
        conn.rollback()
        raise ApiError(409, "index_exists", f"An index named {name} was just made; try again.") from None
    conn.execute(sql.SQL("ANALYZE {}").format(lab_table))
    conn.commit()
    try:
        after_ms, after_plan = _timed(ws_id, sql_text, runs)
        row = conn.execute(
            f"INSERT INTO qlens.index_experiments (workspace_id, table_name, columns, index_name, ddl, before_ms, "
            f"after_ms, runs, status) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'kept') RETURNING {_EXP_COLS}",
            (ws_id, table, columns, name, ddl, round(before_ms, 3), round(after_ms, 3), runs)).fetchone()
        out = ExperimentOut(**row, before_plan=before_plan, after_plan=after_plan)
        conn.commit()  # the index is committed already; its experiment row goes with it
    except BaseException:
        # No index may stay behind without its experiment: it would block this experiment until a reset.
        conn.rollback()
        conn.execute(sql.SQL("DROP INDEX IF EXISTS {}").format(sql.Identifier(_lab(ws_id), name)))
        conn.commit()
        raise
    return out


def list_experiments(conn: psycopg.Connection, ws_id: int) -> list[ExperimentRow]:
    rows = conn.execute(f"SELECT {_EXP_COLS} FROM qlens.index_experiments WHERE workspace_id = %s "
                        "ORDER BY created_at DESC, id DESC", (ws_id,)).fetchall()
    # Applying a new design drops the lab, and the indexes with it, without touching these rows.
    alive = {r["relname"] for r in conn.execute(
        "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = %s AND c.relkind = 'i'", (_lab(ws_id),))}
    return [ExperimentRow(**{**r, "status": r["status"] if r["index_name"] in alive else "dropped"}) for r in rows]


def drop_index(conn: psycopg.Connection, ws_id: int, experiment_id: int) -> ExperimentRow:
    _lock(conn, ws_id)
    row = conn.execute(f"SELECT {_EXP_COLS} FROM qlens.index_experiments WHERE id = %s AND workspace_id = %s",
                       (experiment_id, ws_id)).fetchone()
    if row is None:
        raise ApiError(404, "experiment_not_found", "Experiment not found.")
    if row["status"] == "dropped":
        return ExperimentRow(**row)  # its index is gone; a newer index may carry the same name now
    conn.execute(sql.SQL("DROP INDEX IF EXISTS {}").format(sql.Identifier(_lab(ws_id), row["index_name"])))
    return ExperimentRow(**conn.execute(
        f"UPDATE qlens.index_experiments SET status = 'dropped' WHERE id = %s RETURNING {_EXP_COLS}",
        (experiment_id,)).fetchone())
