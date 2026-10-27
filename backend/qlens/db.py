import hashlib
import hmac
from collections.abc import Iterator
from typing import Annotated, Literal

import psycopg
from fastapi import Depends
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from qlens.config import get_settings

# A psycopg_pool pool cannot be reopened once closed, so each app startup builds a fresh one.
# Importing this module never touches the DB.
pool: ConnectionPool | None = None


def open_pool() -> ConnectionPool:
    global pool
    close_pool()
    pool = ConnectionPool(
        get_settings().database_url,
        kwargs={"row_factory": dict_row},
        min_size=1,
        max_size=get_settings().db_pool_max,
        open=False,
    )
    pool.open(wait=False)
    return pool


def close_pool() -> None:
    global pool
    if pool is not None:
        pool.close()
        pool = None


def get_conn() -> Iterator[psycopg.Connection]:
    """FastAPI dependency: one transaction per request, committed on success, rolled back on error."""
    if pool is None:
        raise RuntimeError("connection pool is not open (app not started)")
    with pool.connection() as conn:
        try:
            yield conn
        except BaseException:
            conn.rollback()
            raise
        else:
            conn.commit()


# scope="function": the dependency exits (and commits) before the response is sent. With FastAPI's
# default request scope the commit would run after the client already received a 2xx, so a commit
# failure would be invisible and an immediate follow-up request could miss the write.
Conn = Annotated[psycopg.Connection, Depends(get_conn, scope="function")]


# ---- per-workspace sandbox role and schemas -------------------------------------------------------

SchemaKind = Literal["main", "src", "lab"]
_SCHEMA_SUFFIX = {"main": "", "src": "_src", "lab": "_lab"}


def ws_role(ws_id: int) -> str:
    return f"{get_settings().role_prefix}{ws_id}"


def ws_password(ws_id: int) -> str:
    """Derived, not stored: the app can always recompute it from SECRET_KEY."""
    return hmac.new(get_settings().secret_key.encode(), f"ws:{ws_id}".encode(), hashlib.sha256).hexdigest()


def ws_conn_params(ws_id: int, search_path: str | None = None, **extra) -> dict:
    """Keyword arguments for psycopg.connect() as the workspace's own LOGIN role.

    Same host, port, database and TLS settings (sslmode, sslrootcert, channel_binding...) as DATABASE_URL;
    only the user and password differ. A search_path is added to any startup `options` the URL already
    carries (some hosts put their own there), and `extra` (connect_timeout, ...) overrides the URL.
    """
    params = conninfo_to_dict(get_settings().database_url)
    params.update(user=ws_role(ws_id), password=ws_password(ws_id))
    if search_path:
        params["options"] = " ".join(filter(None, [params.get("options"), f"-c search_path={search_path}"]))
    params.update(extra)
    return params


def ws_schema(ws_id: int, kind: SchemaKind) -> str:
    return f"ws_{ws_id}{_SCHEMA_SUFFIX[kind]}"


def create_ws_schema(conn: psycopg.Connection, ws_id: int, kind: SchemaKind) -> None:
    schema, role = sql.Identifier(ws_schema(ws_id, kind)), sql.Identifier(ws_role(ws_id))
    conn.execute(sql.SQL("CREATE SCHEMA {}").format(schema))
    conn.execute(sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(schema, role))
    # Default privileges cover tables created later by the owning role; the explicit grant covers existing ones.
    conn.execute(sql.SQL("ALTER DEFAULT PRIVILEGES IN SCHEMA {} GRANT SELECT ON TABLES TO {}").format(schema, role))
    conn.execute(sql.SQL("GRANT SELECT ON ALL TABLES IN SCHEMA {} TO {}").format(schema, role))
    if kind == "main":
        # Only the generated tables can be changed (the Data page). The sheet copies (_src) and the lab stay
        # read-only for the role, whatever SQL reaches it.
        conn.execute(sql.SQL("ALTER DEFAULT PRIVILEGES IN SCHEMA {} GRANT INSERT, UPDATE, DELETE ON TABLES TO {}")
                     .format(schema, role))
        conn.execute(sql.SQL("ALTER DEFAULT PRIVILEGES IN SCHEMA {} GRANT USAGE ON SEQUENCES TO {}")
                     .format(schema, role))
        grant_ws_writes(conn, ws_id)


def grant_ws_writes(conn: psycopg.Connection, ws_id: int) -> None:
    """INSERT, UPDATE and DELETE on the generated tables of ws_<id> (and their identity sequences). Idempotent.

    Called when the main schema is made and again after Apply, and lazily before a write on a workspace applied
    before writes existed. Views (original_sheet) get no write rights: they are not something to edit.
    """
    schema, role = sql.Identifier(ws_schema(ws_id, "main")), sql.Identifier(ws_role(ws_id))
    conn.execute(sql.SQL("GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA {} TO {}").format(schema, role))
    conn.execute(sql.SQL("GRANT USAGE ON ALL SEQUENCES IN SCHEMA {} TO {}").format(schema, role))
    views = conn.execute(
        "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = %s AND c.relkind IN ('v', 'm')", (ws_schema(ws_id, "main"),)).fetchall()
    for v in views:
        name = v["relname"] if isinstance(v, dict) else v[0]
        conn.execute(sql.SQL("REVOKE INSERT, UPDATE, DELETE ON {} FROM {}").format(
            sql.Identifier(ws_schema(ws_id, "main"), name), role))


def ws_can_write(conn: psycopg.Connection, ws_id: int, table: str) -> bool:
    # A list of privileges in one call means "any of"; all three are needed.
    target = (ws_role(ws_id), sql.Identifier(ws_schema(ws_id, "main"), table).as_string(conn))
    row = conn.execute("SELECT has_table_privilege(%s, %s, 'INSERT') AND has_table_privilege(%s, %s, 'UPDATE') "
                       "AND has_table_privilege(%s, %s, 'DELETE') AS ok", target * 3).fetchone()
    return bool(row["ok"] if isinstance(row, dict) else row[0])


def drop_ws_schema(conn: psycopg.Connection, ws_id: int, kind: SchemaKind) -> None:
    conn.execute(sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(sql.Identifier(ws_schema(ws_id, kind))))
