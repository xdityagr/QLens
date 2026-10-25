"""What is really in a workspace schema, read from the system catalogs (not from the proposal).

The proposal only lends each table its lane colour: tables it does not know (the lab may hold the user's own)
get one by position.
"""
from typing import TypedDict

import psycopg
from psycopg import sql
from pydantic import BaseModel

from qlens import db
from qlens.design.proposal import N_COLORS


class FkRef(TypedDict):
    table: str
    column: str


class ColumnInfo(TypedDict):
    name: str
    data_type: str
    not_null: bool
    is_pk: bool
    fk: FkRef | None


class IndexInfo(TypedDict):
    name: str
    columns: list[str]
    unique: bool


class TableInfo(TypedDict):
    name: str
    color_index: int
    row_count: int
    columns: list[ColumnInfo]
    indexes: list[IndexInfo]


class SchemaOut(BaseModel):
    tables: list[TableInfo]


def _applied_tables(conn: psycopg.Connection, ws_id: int) -> dict[str, tuple[int, int]]:
    """name -> (ordinal, color_index) in the workspace's applied proposal."""
    rows = conn.execute(
        "SELECT t.name, t.ordinal, t.color_index FROM qlens.proposed_tables t "
        "JOIN qlens.schema_proposals p ON p.id = t.proposal_id JOIN qlens.datasets d ON d.id = p.dataset_id "
        "WHERE d.workspace_id = %s AND p.status = 'applied'", (ws_id,)).fetchall()
    return {r["name"]: (r["ordinal"], r["color_index"]) for r in rows}


def describe(conn: psycopg.Connection, ws_id: int, kind: db.SchemaKind = "main") -> SchemaOut:
    schema = db.ws_schema(ws_id, kind)
    applied = _applied_tables(conn, ws_id)
    found = conn.execute(
        "SELECT c.oid, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = %s AND c.relkind IN ('r', 'p')", (schema,)).fetchall()
    # The proposal's order first (the order the design screen shows), then anything else by name.
    found.sort(key=lambda r: (r["name"] not in applied, applied.get(r["name"], (0, 0))[0], r["name"]))
    oids = [r["oid"] for r in found]

    columns = conn.execute(
        """SELECT a.attrelid AS table_oid, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS data_type,
                  a.attnotnull AS not_null,
                  EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = a.attrelid AND k.contype = 'p'
                                                         AND a.attnum = ANY (k.conkey)) AS is_pk,
                  fk.ref_table, fk.ref_column
           FROM pg_attribute a
           LEFT JOIN LATERAL (
               SELECT rc.relname AS ref_table, ra.attname AS ref_column
               FROM pg_constraint k
               CROSS JOIN LATERAL unnest(k.conkey, k.confkey) AS u (col, ref_col)
               JOIN pg_class rc ON rc.oid = k.confrelid
               JOIN pg_attribute ra ON ra.attrelid = k.confrelid AND ra.attnum = u.ref_col
               WHERE k.conrelid = a.attrelid AND k.contype = 'f' AND u.col = a.attnum
               ORDER BY k.conname LIMIT 1
           ) fk ON true
           WHERE a.attrelid = ANY (%s::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
           ORDER BY a.attrelid, a.attnum""", (oids,)).fetchall()
    indexes = conn.execute(
        """SELECT i.indrelid AS table_oid, ic.relname AS name, i.indisunique AS unique,
                  -- Key columns in index order; an expression shows as its text.
                  ARRAY(SELECT coalesce(a.attname, pg_get_indexdef(i.indexrelid, k, true))
                        FROM generate_series(1, i.indnkeyatts) AS k
                        LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[k - 1]
                        ORDER BY k) AS columns
           FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
           WHERE i.indrelid = ANY (%s::oid[])
           ORDER BY i.indrelid, i.indisprimary DESC, ic.relname""", (oids,)).fetchall()

    cols_of: dict[int, list[ColumnInfo]] = {o: [] for o in oids}
    for c in columns:
        fk = FkRef(table=c["ref_table"], column=c["ref_column"]) if c["ref_table"] is not None else None
        cols_of[c["table_oid"]].append(ColumnInfo(name=c["name"], data_type=c["data_type"],
                                                  not_null=c["not_null"], is_pk=c["is_pk"], fk=fk))
    idx_of: dict[int, list[IndexInfo]] = {o: [] for o in oids}
    for i in indexes:
        idx_of[i["table_oid"]].append(IndexInfo(name=i["name"], columns=i["columns"], unique=i["unique"]))

    tables = []
    for n, t in enumerate(found):
        # Exact counts: workspace tables are at most 100,000 rows.
        count = conn.execute(sql.SQL("SELECT count(*) AS n FROM {}").format(
            sql.Identifier(schema, t["name"]))).fetchone()["n"]
        color = applied[t["name"]][1] if t["name"] in applied else n % N_COLORS
        tables.append(TableInfo(name=t["name"], color_index=color, row_count=count,
                                columns=cols_of[t["oid"]], indexes=idx_of[t["oid"]]))
    return SchemaOut(tables=tables)
