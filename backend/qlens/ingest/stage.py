from datetime import date
from decimal import Decimal
from typing import Any, Literal

import psycopg
from psycopg import sql
from pydantic import BaseModel

from qlens import db
from qlens.ingest.parse import RawTable, read_table

PREVIEW_ROWS = 50
SAMPLE_VALUES = 5

InferredType = Literal["integer", "numeric", "boolean", "date", "text"]

# Types are inferred by SQL over the raw text, not in Python: the database is the one that will
# have to cast the values, so it is also the one that decides whether a cast is safe.
_INT_RE = r"^[+-]?(0|[1-9]\d{0,8})$"
_NUM_RE = r"^[+-]?(0|[1-9]\d{0,14})(\.\d+)?$"
_DATEISH_RE = r"^(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{4})$"
_BOOL_WORDS = ("true", "false", "yes", "no", "y", "n")
_BOOL_TRUE = ("true", "yes", "y")


class ColumnOut(BaseModel):
    id: int
    ordinal: int
    name: str
    label: str
    inferred_type: InferredType
    null_count: int
    distinct_count: int
    sample_values: list[str]


class DatasetOut(BaseModel):
    id: int
    original_filename: str
    source: Literal["upload", "sample"]
    row_count: int
    column_count: int
    status: Literal["imported", "analyzed", "applied"]
    columns: list[ColumnOut]


class Preview(BaseModel):
    columns: list[str]
    rows: list[list[Any]]


class DatasetDetailOut(DatasetOut):
    preview: Preview


def _src(ws_id: int, table: str) -> sql.Composed:
    return sql.SQL("{}.{}").format(sql.Identifier(db.ws_schema(ws_id, "src")), sql.Identifier(table))


# ---- import ---------------------------------------------------------------------------------------

def import_dataset(conn: psycopg.Connection, ws_id: int, filename: str, data: bytes,
                   source: Literal["upload", "sample"]) -> DatasetOut:
    # Parsing first: a rejected file must leave the workspace's current dataset untouched.
    table = read_table(filename, data)
    with conn.transaction():
        _reset_workspace(conn, ws_id)
        _load_raw(conn, ws_id, table)
        types = [_infer_type(conn, ws_id, name) for name in table.names]
        _build_staging(conn, ws_id, table.names, types)
        dataset_id = _record(conn, ws_id, filename, len(data), source, table, types)
    out = get_dataset(conn, ws_id)
    assert out is not None and out.id == dataset_id
    return out


def _reset_workspace(conn: psycopg.Connection, ws_id: int) -> None:
    # Deleting the row cascades to its columns, analysis results and proposals.
    conn.execute("DELETE FROM qlens.datasets WHERE workspace_id = %s", (ws_id,))
    for kind in ("main", "src", "lab"):
        db.drop_ws_schema(conn, ws_id, kind)
    # main stays (empty) because the sandbox role's search_path points at it.
    db.create_ws_schema(conn, ws_id, "main")
    db.create_ws_schema(conn, ws_id, "src")


def _load_raw(conn: psycopg.Connection, ws_id: int, table: RawTable) -> None:
    cols = sql.SQL(", ").join(sql.Identifier(n) for n in table.names)
    conn.execute(sql.SQL("CREATE TABLE {} (_row_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, {})").format(
        _src(ws_id, "_raw"), sql.SQL(", ").join(sql.SQL("{} text").format(sql.Identifier(n)) for n in table.names)))
    with conn.cursor() as cur:
        with cur.copy(sql.SQL("COPY {} ({}) FROM STDIN").format(_src(ws_id, "_raw"), cols)) as cp:
            for row in table.rows:
                cp.write_row(row)


def _infer_type(conn: psycopg.Connection, ws_id: int, name: str) -> InferredType:
    """The first of integer, numeric, boolean, date that fits every non-null value; else text."""
    c = sql.Identifier(name)
    row = conn.execute(
        sql.SQL(
            "SELECT bool_and({c} ~ %(int)s) AS is_int, "
            "       bool_and({c} ~ %(num)s) AS is_num, "
            "       bool_and(lower({c}) = ANY(%(bools)s)) AS is_bool, "
            # CASE so the PL/pgSQL parser only runs on values that look like dates.
            "       bool_and(CASE WHEN {c} ~ %(dateish)s THEN qlens.try_date({c}) IS NOT NULL ELSE false END) AS is_date "
            "FROM {t} WHERE {c} IS NOT NULL"
        ).format(c=c, t=_src(ws_id, "_raw")),
        {"int": _INT_RE, "num": _NUM_RE, "bools": list(_BOOL_WORDS), "dateish": _DATEISH_RE},
    ).fetchone()
    # bool_and over zero rows is NULL: an all-empty column stays text.
    if row["is_int"]:
        return "integer"
    if row["is_num"]:
        return "numeric"
    if row["is_bool"]:
        return "boolean"
    if row["is_date"]:
        return "date"
    return "text"


def _cast(name: str, type_: InferredType) -> sql.Composable:
    c = sql.Identifier(name)
    match type_:
        case "integer":
            expr = sql.SQL("{}::bigint").format(c)
        case "numeric":
            expr = sql.SQL("{}::numeric").format(c)
        case "boolean":
            expr = sql.SQL("lower({}) IN ({})").format(
                c, sql.SQL(", ").join(sql.Literal(w) for w in _BOOL_TRUE))
        case "date":
            expr = sql.SQL("qlens.try_date({})").format(c)
        case _:
            expr = c
    return sql.SQL("{} AS {}").format(expr, c)


def _build_staging(conn: psycopg.Connection, ws_id: int, names: list[str], types: list[InferredType]) -> None:
    casts = sql.SQL(", ").join(_cast(n, t) for n, t in zip(names, types))
    conn.execute(sql.SQL("CREATE TABLE {} AS SELECT _row_id, {} FROM {} ORDER BY _row_id").format(
        _src(ws_id, "_staging"), casts, _src(ws_id, "_raw")))
    conn.execute(sql.SQL("ALTER TABLE {} ADD PRIMARY KEY (_row_id)").format(_src(ws_id, "_staging")))
    # Default privileges cover tables made by this role; this makes the sandbox grant explicit.
    conn.execute(sql.SQL("GRANT SELECT ON ALL TABLES IN SCHEMA {} TO {}").format(
        sql.Identifier(db.ws_schema(ws_id, "src")), sql.Identifier(db.ws_role(ws_id))))


def _profile(conn: psycopg.Connection, ws_id: int, names: list[str]) -> list[tuple[int, int, list[str]]]:
    """(null_count, distinct_count, most frequent values) of each staged column, from the current data."""
    staging = _src(ws_id, "_staging")
    # One pass for every column's counts; most-frequent sample values need a query per column.
    aggs = sql.SQL(", ").join(
        sql.SQL("count({c}) AS {n}, count(DISTINCT {c}) AS {d}").format(
            c=sql.Identifier(name), n=sql.Identifier(f"nn_{i}"), d=sql.Identifier(f"d_{i}"))
        for i, name in enumerate(names))
    counts = conn.execute(sql.SQL("SELECT count(*) AS total, {} FROM {}").format(aggs, staging)).fetchone()
    out = []
    for i, name in enumerate(names):
        c = sql.Identifier(name)
        samples = [r["v"] for r in conn.execute(
            sql.SQL("SELECT {c}::text AS v FROM {t} WHERE {c} IS NOT NULL "
                    "GROUP BY {c} ORDER BY count(*) DESC, {c}::text LIMIT %s").format(c=c, t=staging),
            (SAMPLE_VALUES,))]
        out.append((counts["total"] - counts[f"nn_{i}"], counts[f"d_{i}"], samples))
    return out


def refresh_column_profile(conn: psycopg.Connection, ws_id: int, dataset_id: int, names: list[str]) -> None:
    """Re-profile columns after _staging was edited: discovery prunes keys and FDs by these counts."""
    for name, (nulls, distinct, samples) in zip(names, _profile(conn, ws_id, names)):
        conn.execute(
            "UPDATE qlens.dataset_columns SET null_count = %s, distinct_count = %s, sample_values = %s "
            "WHERE dataset_id = %s AND name = %s", (nulls, distinct, samples, dataset_id, name))


def _record(conn: psycopg.Connection, ws_id: int, filename: str, size: int, source: str,
            table: RawTable, types: list[InferredType]) -> int:
    profile = _profile(conn, ws_id, table.names)
    total = conn.execute(sql.SQL("SELECT count(*) AS n FROM {}").format(_src(ws_id, "_staging"))).fetchone()["n"]

    dataset_id = conn.execute(
        "INSERT INTO qlens.datasets (workspace_id, original_filename, source, file_size_bytes, row_count, "
        "column_count) VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
        (ws_id, filename, source, size, total, len(table.names)),
    ).fetchone()["id"]

    for i, (name, label, type_, (nulls, distinct, samples)) in enumerate(
            zip(table.names, table.labels, types, profile)):
        conn.execute(
            "INSERT INTO qlens.dataset_columns (dataset_id, ordinal, name, label, inferred_type, null_count, "
            "distinct_count, sample_values) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (dataset_id, i + 1, name, label, type_, nulls, distinct, samples),
        )
    return dataset_id


# ---- read -----------------------------------------------------------------------------------------

def get_dataset(conn: psycopg.Connection, ws_id: int) -> DatasetOut | None:
    ds = conn.execute(
        "SELECT id, original_filename, source, row_count, column_count, status FROM qlens.datasets "
        "WHERE workspace_id = %s", (ws_id,)).fetchone()
    if ds is None:
        return None
    cols = conn.execute(
        "SELECT id, ordinal, name, label, inferred_type, null_count, distinct_count, sample_values "
        "FROM qlens.dataset_columns WHERE dataset_id = %s ORDER BY ordinal", (ds["id"],)).fetchall()
    return DatasetOut(**ds, columns=[ColumnOut(**c) for c in cols])


def _jsonable(v: Any) -> Any:
    if isinstance(v, Decimal):
        return str(v)           # exact; a float would turn 118.50 into 118.5
    if isinstance(v, date):
        return v.isoformat()
    return v


def get_dataset_detail(conn: psycopg.Connection, ws_id: int) -> DatasetDetailOut | None:
    ds = get_dataset(conn, ws_id)
    if ds is None:
        return None
    names = [c.name for c in ds.columns]
    rows = conn.execute(
        sql.SQL("SELECT {} FROM {} ORDER BY _row_id LIMIT %s").format(
            sql.SQL(", ").join(sql.Identifier(n) for n in names), _src(ws_id, "_staging")),
        (PREVIEW_ROWS,)).fetchall()
    preview = Preview(columns=names, rows=[[_jsonable(r[n]) for n in names] for r in rows])
    return DatasetDetailOut(**ds.model_dump(), preview=preview)
