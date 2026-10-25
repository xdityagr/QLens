import hashlib
import hmac
from collections.abc import Iterator
from typing import Literal

import psycopg
from psycopg import sql
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
        max_size=10,
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


# ---- per-workspace sandbox role and schemas -------------------------------------------------------

SchemaKind = Literal["main", "src", "lab"]
_SCHEMA_SUFFIX = {"main": "", "src": "_src", "lab": "_lab"}


def ws_role(ws_id: int) -> str:
    return f"{get_settings().role_prefix}{ws_id}"


def ws_password(ws_id: int) -> str:
    """Derived, not stored: the app can always recompute it from SECRET_KEY."""
    return hmac.new(get_settings().secret_key.encode(), f"ws:{ws_id}".encode(), hashlib.sha256).hexdigest()


def ws_schema(ws_id: int, kind: SchemaKind) -> str:
    return f"ws_{ws_id}{_SCHEMA_SUFFIX[kind]}"


def create_ws_schema(conn: psycopg.Connection, ws_id: int, kind: SchemaKind) -> None:
    schema, role = sql.Identifier(ws_schema(ws_id, kind)), sql.Identifier(ws_role(ws_id))
    conn.execute(sql.SQL("CREATE SCHEMA {}").format(schema))
    conn.execute(sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(schema, role))
    # Default privileges cover tables created later by the owning role; the explicit grant covers existing ones.
    conn.execute(sql.SQL("ALTER DEFAULT PRIVILEGES IN SCHEMA {} GRANT SELECT ON TABLES TO {}").format(schema, role))
    conn.execute(sql.SQL("GRANT SELECT ON ALL TABLES IN SCHEMA {} TO {}").format(schema, role))


def drop_ws_schema(conn: psycopg.Connection, ws_id: int, kind: SchemaKind) -> None:
    conn.execute(sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(sql.Identifier(ws_schema(ws_id, kind))))
