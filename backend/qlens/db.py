from collections.abc import Iterator

import psycopg
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
