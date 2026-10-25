from collections.abc import Iterator

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from qlens.config import get_settings

# open=False: the FastAPI lifespan opens and closes it, and importing the module never touches the DB.
pool = ConnectionPool(
    get_settings().database_url,
    kwargs={"row_factory": dict_row},
    min_size=1,
    max_size=10,
    open=False,
)


def get_conn() -> Iterator[psycopg.Connection]:
    """FastAPI dependency: one transaction per request, committed on success, rolled back on error."""
    with pool.connection() as conn:
        try:
            yield conn
        except BaseException:
            conn.rollback()
            raise
        else:
            conn.commit()
