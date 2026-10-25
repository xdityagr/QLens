from datetime import datetime

import psycopg
from psycopg import sql
from pydantic import BaseModel, Field, field_validator

from qlens import db
from qlens.errors import ApiError


class WorkspaceRow(BaseModel):
    id: int
    owner_id: int
    name: str
    created_at: datetime


class WorkspaceIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)

    @field_validator("name")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Give the workspace a name.")
        return v


class WorkspaceOut(BaseModel):
    id: int
    name: str
    created_at: datetime
    stage: str
    # NULL (not 0) while the workspace has no dataset; the UI distinguishes "empty" from "zero".
    row_count: int | None
    column_count: int | None
    table_count: int | None
    query_count: int
    last_activity_at: datetime


_SUMMARY_COLS = ("workspace_id AS id, name, created_at, stage, row_count, column_count, table_count, "
                 "query_count, last_activity_at")


def get_workspace_row(conn: psycopg.Connection, ws_id: int, owner_id: int) -> WorkspaceRow | None:
    row = conn.execute(
        "SELECT id, owner_id, name, created_at FROM qlens.workspaces WHERE id = %s AND owner_id = %s",
        (ws_id, owner_id),
    ).fetchone()
    return WorkspaceRow(**row) if row else None


def get_workspace(conn: psycopg.Connection, ws_id: int) -> WorkspaceOut:
    row = conn.execute(
        f"SELECT {_SUMMARY_COLS} FROM qlens.v_workspace_summary WHERE workspace_id = %s", (ws_id,)
    ).fetchone()
    return WorkspaceOut(**row)


def list_workspaces(conn: psycopg.Connection, owner_id: int) -> list[WorkspaceOut]:
    rows = conn.execute(
        f"SELECT {_SUMMARY_COLS} FROM qlens.v_workspace_summary WHERE owner_id = %s "
        "ORDER BY last_activity_at DESC, workspace_id DESC",
        (owner_id,),
    ).fetchall()
    return [WorkspaceOut(**r) for r in rows]


def create_workspace(conn: psycopg.Connection, owner_id: int, name: str) -> WorkspaceOut:
    row = conn.execute(
        "INSERT INTO qlens.workspaces (owner_id, name) VALUES (%s, %s) "
        "ON CONFLICT (owner_id, name) DO NOTHING RETURNING id",
        (owner_id, name),
    ).fetchone()
    if row is None:
        raise ApiError(409, "workspace_name_taken", "You already have a workspace with this name.")
    ws_id = row["id"]
    role = sql.Identifier(db.ws_role(ws_id))
    # Everything below runs in the request transaction, so a failure leaves no role or schema behind.
    conn.execute(sql.SQL("CREATE ROLE {} LOGIN PASSWORD {} NOINHERIT CONNECTION LIMIT 3").format(
        role, sql.Literal(db.ws_password(ws_id))))
    conn.execute(sql.SQL("ALTER ROLE {} SET statement_timeout = '5s'").format(role))
    conn.execute(sql.SQL("ALTER ROLE {} SET default_transaction_read_only = on").format(role))
    conn.execute(sql.SQL("ALTER ROLE {} SET idle_in_transaction_session_timeout = '10s'").format(role))
    conn.execute(sql.SQL("ALTER ROLE {} SET search_path = {}, {}").format(
        role, sql.Identifier(db.ws_schema(ws_id, "main")), sql.Identifier(db.ws_schema(ws_id, "src"))))
    db.create_ws_schema(conn, ws_id, "main")
    db.create_ws_schema(conn, ws_id, "src")
    return get_workspace(conn, ws_id)


def delete_workspace(conn: psycopg.Connection, ws_id: int) -> None:
    for kind in ("main", "src", "lab"):
        db.drop_ws_schema(conn, ws_id, kind)
    role_name = db.ws_role(ws_id)
    if conn.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (role_name,)).fetchone():
        role = sql.Identifier(role_name)
        # PG16+: a CREATEROLE creator has ADMIN but not INHERIT on roles it made, and DROP OWNED
        # needs the role's privileges, so grant them to ourselves first.
        conn.execute(sql.SQL("GRANT {} TO CURRENT_USER WITH INHERIT TRUE").format(role))
        conn.execute(sql.SQL("DROP OWNED BY {}").format(role))
        conn.execute(sql.SQL("DROP ROLE {}").format(role))
    conn.execute("DELETE FROM qlens.workspaces WHERE id = %s", (ws_id,))
