"""Runs user SQL as the workspace's own role, in a throwaway connection.

What makes this safe does not depend on parsing the SQL:
  * the role can only SELECT from this workspace's schemas (no USAGE on `qlens` or other workspaces),
  * the transaction is READ ONLY and rolled back at the end,
  * statement_timeout is set per run (never above MAX_TIMEOUT_MS),
  * rows are pulled through a cursor, so a huge result never sits in memory.
"""

from time import perf_counter
from typing import Literal

import psycopg
from psycopg.adapt import Loader
from psycopg.pq import Format
from pydantic import BaseModel

from qlens import db
from qlens.config import get_settings
from qlens.query.serialize import cell

MAX_TIMEOUT_MS = 5000
_CURSOR = "qlens_run"
_DECLARE = f"DECLARE {_CURSOR} NO SCROLL CURSOR WITHOUT HOLD FOR "
_EXPLAIN = "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "

# oid -> display name; builtin and user type oids are stable for the life of the cluster.
_type_names: dict[int, str] = {}


class QueryResult(BaseModel):
    columns: list[dict[str, str]]
    rows: list[list]
    row_count: int
    truncated: bool
    duration_ms: float


class QueryError(Exception):
    def __init__(self, code: str, message: str, sqlstate: str | None = None, position: int | None = None,
                 duration_ms: float | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.sqlstate = sqlstate
        self.position = position
        self.duration_ms = duration_ms


def _tolerant(base: type[Loader]) -> type[Loader]:
    # psycopg raises on 'infinity' and on years past 9999; a SQL lab should show them, not fail the query.
    # Wraps rather than subclasses because the compiled loaders cannot be subclassed.
    class Tolerant(Loader):
        def __init__(self, oid: int, context=None):
            super().__init__(oid, context)
            self._inner = base(oid, context)

        def load(self, data):
            try:
                return self._inner.load(data)
            except (psycopg.DataError, ValueError):
                return bytes(data).decode()

    return Tolerant


def _install_tolerant_loaders(conn: psycopg.Connection) -> None:
    for name in ("date", "timestamp", "timestamptz"):
        oid = conn.adapters.types[name].oid
        conn.adapters.register_loader(oid, _tolerant(conn.adapters.get_loader(oid, Format.TEXT)))


def _type_name_map(conn: psycopg.Connection, oids: list[int]) -> dict[int, str]:
    missing = [o for o in set(oids) if o not in _type_names]
    if missing:
        rows = conn.execute("SELECT oid::int8, format_type(oid, NULL) FROM pg_type WHERE oid = ANY(%s)", (missing,))
        _type_names.update({oid: name for oid, name in rows})
    return {o: _type_names.get(o, str(o)) for o in oids}


def _error(e: psycopg.Error, started: float, prefix_len: int = 0) -> QueryError:
    duration = (perf_counter() - started) * 1000
    if isinstance(e, psycopg.errors.QueryCanceled):  # 57014: only statement_timeout can cancel here
        return QueryError("timeout", "The query ran past its time limit and was stopped.",
                           e.sqlstate, None, duration)
    position = e.diag.statement_position
    return QueryError("db_error", e.diag.message_primary or str(e), e.sqlstate,
                      int(position) - prefix_len if position and int(position) > prefix_len else None, duration)


def _connect(ws_id: int, target: Literal["main", "lab"]) -> psycopg.Connection:
    """A fresh connection as the workspace's own LOGIN role, seeing only the target schema (and _src)."""
    settings = get_settings()
    # Startup options outrank the role's ALTER ROLE ... SET search_path, which only knows the main schema.
    search_path = f"{db.ws_schema(ws_id, target)},{db.ws_schema(ws_id, 'src')}"
    try:
        return psycopg.connect(host=settings.pg_host, port=settings.pg_port, dbname=settings.pg_dbname,
                               user=db.ws_role(ws_id), password=db.ws_password(ws_id),
                               connect_timeout=5, prepare_threshold=5, options=f"-c search_path={search_path}")
    except psycopg.Error as e:
        # Never echo str(e): connection errors name the host, port and role.
        if e.sqlstate == "53300":  # too_many_connections: the role's CONNECTION LIMIT
            raise QueryError("db_error", "Too many queries are running for this workspace — try again in a moment.",
                             e.sqlstate) from None
        raise QueryError("db_error", "Could not reach the sandbox database.", e.sqlstate) from None


def _begin(conn: psycopg.Connection, timeout_ms: int) -> None:
    conn.read_only = True  # the transaction opens as BEGIN READ ONLY
    # cursor_tuple_fraction = 1: plan for all rows, as a plain SELECT would be, so timings match EXPLAIN.
    conn.execute("SELECT set_config('statement_timeout', %s, true), set_config('cursor_tuple_fraction', '1', true)",
                 (str(max(1, min(int(timeout_ms), MAX_TIMEOUT_MS))),))


def explain_analyze(ws_id: int, sql_text: str, *, target: Literal["main", "lab"] = "main", runs: int = 1,
                    timeout_ms: int = MAX_TIMEOUT_MS) -> list[dict]:
    """EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) of an already validated SELECT, `runs` times in one connection.

    Same guarantees as run(): workspace role, READ ONLY transaction rolled back, statement_timeout per statement.
    Returns each run's plan document (the single element of EXPLAIN's JSON array).
    """
    conn = _connect(ws_id, target)
    started = perf_counter()
    try:
        _begin(conn, timeout_ms)
        plans = []
        for _ in range(runs):
            started = perf_counter()
            # prepare=True: the extended protocol refuses a second statement smuggled in after the SELECT.
            plans.append(conn.execute(_EXPLAIN + sql_text, prepare=True).fetchone()[0][0])
        return plans
    except psycopg.Error as e:
        raise _error(e, started, len(_EXPLAIN)) from None
    finally:
        try:
            conn.rollback()
        except psycopg.Error:
            pass
        conn.close()


def run(ws_id: int, sql_text: str, *, target: Literal["main", "lab"] = "main",
        max_rows: int = 1000, timeout_ms: int = MAX_TIMEOUT_MS) -> QueryResult:
    conn = _connect(ws_id, target)
    started = perf_counter()
    try:
        _install_tolerant_loaders(conn)
        _begin(conn, timeout_ms)
        started = perf_counter()
        # prepare=True forces the extended protocol, which refuses a second statement smuggled in after the SELECT.
        conn.execute(_DECLARE + sql_text, prepare=True)
        cur = conn.execute(f"FETCH FORWARD {int(max_rows) + 1} FROM {_CURSOR}")
        fetched = cur.fetchall()
        duration_ms = (perf_counter() - started) * 1000
        description = cur.description or []
        names = _type_name_map(conn, [c.type_code for c in description])
        columns = [{"name": c.name, "type": names[c.type_code]} for c in description]
    except psycopg.Error as e:
        raise _error(e, started, len(_DECLARE)) from None
    finally:
        try:
            conn.rollback()
        except psycopg.Error:
            pass
        conn.close()
    truncated = len(fetched) > max_rows
    rows = [[cell(v) for v in row] for row in fetched[:max_rows]]
    return QueryResult(columns=columns, rows=rows, row_count=len(rows), truncated=truncated,
                       duration_ms=duration_ms)
