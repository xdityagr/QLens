from datetime import datetime
from typing import Annotated, Literal

import psycopg
from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

from qlens import db
from qlens.auth.deps import owned_workspace
from qlens.data import sqlwrite
from qlens.errors import ApiError
from qlens.query import sandbox
from qlens.query.sandbox import QueryError, QueryResult, WriteRefused
from qlens.query.validate import validate_select, validate_write
from qlens.workspaces.service import WorkspaceRow

router = APIRouter(prefix="/workspaces/{workspace_id}", tags=["query"])

MAX_SQL_CHARS = 20_000
Title = Annotated[str, Field(min_length=1, max_length=80)]
SqlText = Annotated[str, Field(min_length=1, max_length=MAX_SQL_CHARS)]


# ---- models ---------------------------------------------------------------------------------------

class QueryIn(BaseModel):
    sql: SqlText
    saved_query_id: int | None = None
    target: Literal["main", "lab"] = "main"


class QueryOut(BaseModel):
    run_id: int
    result: QueryResult


class WriteIn(BaseModel):
    sql: SqlText


class ReturningOut(BaseModel):
    columns: list[dict[str, str]]
    rows: list[list]
    truncated: bool


class WriteOut(BaseModel):
    run_id: int
    statement: Literal["INSERT", "UPDATE", "DELETE"]
    table: str
    row_count: int              # rows affected
    returning: ReturningOut | None
    duration_ms: float


class SavedQueryIn(BaseModel):
    title: Title
    sql_text: SqlText

    @field_validator("title")
    @classmethod
    def _strip(cls, v: str) -> str:
        return _strip_title(v)


class SavedQueryPatch(BaseModel):
    title: Title | None = None
    sql_text: SqlText | None = None

    @field_validator("title")
    @classmethod
    def _strip(cls, v: str | None) -> str | None:
        return None if v is None else _strip_title(v)


def _strip_title(v: str) -> str:
    v = v.strip()
    if not v:
        raise ValueError("Give the query a title.")
    return v


class SavedQueryOut(BaseModel):
    id: int
    title: str
    sql_text: str
    run_count: int
    last_run_at: datetime | None
    last_duration_ms: float | None
    created_at: datetime
    updated_at: datetime


class RunOut(BaseModel):
    id: int
    saved_query_id: int | None
    sql_text: str
    source: str
    target: str
    status: str
    duration_ms: float | None
    row_count: int | None
    error_message: str | None
    created_at: datetime


class TrendPoint(BaseModel):
    run_id: int
    run_number: int
    created_at: datetime
    duration_ms: float
    prev_ms: float | None
    moving_avg_ms: float | None


class SlowQuery(BaseModel):
    run_id: int
    sql_text: str
    duration_ms: float
    created_at: datetime
    p90_ms: float


_SAVED_COLS = "id, title, sql_text, run_count, last_run_at, last_duration_ms, created_at, updated_at"


# ---- recording ------------------------------------------------------------------------------------

def record_run(conn: psycopg.Connection, ws_id: int, sql_text: str, source: str, target: str,
               result_or_error: QueryResult | QueryError | ApiError, saved_query_id: int | None = None,
               duration_ms: float | None = None) -> int:
    """Insert one query_runs row. The trigger on query_runs updates the saved query's stats for ok runs.

    duration_ms: how long an ApiError outcome ran in the database (a refused write); checks that refuse
    before running have none.
    """
    r = result_or_error
    if isinstance(r, QueryResult):
        status, duration, row_count, error = "ok", r.duration_ms, r.row_count, None
    elif isinstance(r, QueryError):
        status, duration, row_count, error = ("timeout" if r.code == "timeout" else "error"), r.duration_ms, None, r.message
    else:
        status, duration, row_count, error = "error", duration_ms, None, r.message
    return conn.execute(
        "INSERT INTO qlens.query_runs (workspace_id, saved_query_id, sql_text, source, target, status, "
        "duration_ms, row_count, error_message) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
        (ws_id, saved_query_id, sql_text, source, target, status, duration, row_count, error),
    ).fetchone()["id"]


def _require_saved_query(conn: psycopg.Connection, ws_id: int, sq_id: int) -> None:
    found = conn.execute("SELECT 1 FROM qlens.saved_queries WHERE id = %s AND workspace_id = %s",
                         (sq_id, ws_id)).fetchone()
    if found is None:
        raise ApiError(404, "saved_query_not_found", "Saved query not found.")


# ---- running --------------------------------------------------------------------------------------

@router.post("/query")
def run_query(body: QueryIn, conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)):
    if body.saved_query_id is not None:
        _require_saved_query(conn, ws.id, body.saved_query_id)
    sql_text, outcome = body.sql, None
    try:
        try:
            sql_text = validate_select(body.sql)
        except ApiError:
            raise
        except Exception:  # noqa: BLE001 - whatever the checker chokes on, the run is still recorded and answered
            raise ApiError(422, "invalid_query", "This query could not be checked. Simplify it and try again.",
                           detail={"position": None}) from None
        outcome = sandbox.run(ws.id, sql_text, target=body.target)
    except (ApiError, QueryError) as e:
        outcome = e
    run_id = record_run(conn, ws.id, sql_text, "typed", body.target, outcome, body.saved_query_id)
    if isinstance(outcome, QueryResult):
        return QueryOut(run_id=run_id, result=outcome)
    detail = ({"sqlstate": outcome.sqlstate, "position": outcome.position}
              if isinstance(outcome, QueryError) else outcome.detail)
    # Returned, not raised: raising would roll back the request transaction and lose the history row.
    return JSONResponse(status_code=400, content={
        "error": {"code": outcome.code, "message": outcome.message, "detail": detail}})


@router.post("/query/write")
def run_write(body: WriteIn, conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)):
    """One INSERT, UPDATE or DELETE on a generated table, committed. SELECTs never come here (see /query)."""
    sql_text, outcome, stmt, ran_ms = body.sql, None, None, None
    try:
        try:
            stmt = validate_write(body.sql)
        except ApiError:
            raise
        except Exception:  # noqa: BLE001 - as in run_query: answered and recorded, whatever the checker hit
            raise ApiError(422, "invalid_query", "This statement could not be checked. Simplify it and try again.",
                           detail={"position": None}) from None
        sql_text = stmt.sql
        target = sqlwrite.writable_table(conn, ws.id, stmt.schema, stmt.table, stmt.position)
        if not db.ws_can_write(conn, ws.id, target.name):
            # A workspace applied before writes existed; committed now so the sandbox connection sees it.
            db.grant_ws_writes(conn, ws.id)
            conn.commit()
        try:
            outcome = sandbox.run_write(ws.id, sql_text)
        except WriteRefused as e:
            ran_ms = e.duration_ms
            position = e.error.diag.statement_position
            outcome = sqlwrite.explain_error(conn, ws.id, target, stmt.kind, e.error,
                                           int(position) if position else None)
    except (ApiError, QueryError) as e:
        outcome = e
    run_id = record_run(conn, ws.id, sql_text, "typed", "main", outcome, duration_ms=ran_ms)
    if isinstance(outcome, QueryResult):
        returning = (ReturningOut(columns=outcome.columns, rows=outcome.rows, truncated=outcome.truncated)
                     if outcome.columns else None)
        return WriteOut(run_id=run_id, statement=stmt.kind, table=stmt.table, row_count=outcome.row_count,
                        returning=returning, duration_ms=outcome.duration_ms)
    if isinstance(outcome, QueryError):
        status, detail = 400, {"sqlstate": outcome.sqlstate, "position": outcome.position}
    else:
        status, detail = outcome.status, outcome.detail
    # Returned, not raised, so the history row is kept (as in run_query).
    return JSONResponse(status_code=status, content={
        "error": {"code": outcome.code, "message": outcome.message, "detail": detail}})


@router.get("/history")
def history(conn: db.Conn, limit: Annotated[int, Query(ge=1, le=200)] = 50,
            ws: WorkspaceRow = Depends(owned_workspace)) -> list[RunOut]:
    rows = conn.execute(
        "SELECT id, saved_query_id, sql_text, source, target, status, duration_ms, row_count, error_message, "
        "created_at FROM qlens.query_runs WHERE workspace_id = %s ORDER BY created_at DESC, id DESC LIMIT %s",
        (ws.id, limit)).fetchall()
    return [RunOut(**r) for r in rows]


@router.get("/slow-queries")
def slow_queries(conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> list[SlowQuery]:
    rows = conn.execute(
        "SELECT run_id, sql_text, duration_ms, created_at, p90_ms FROM qlens.v_slow_queries "
        "WHERE workspace_id = %s ORDER BY duration_ms DESC, run_id DESC LIMIT 50", (ws.id,)).fetchall()
    return [SlowQuery(**r) for r in rows]


# ---- saved queries --------------------------------------------------------------------------------

@router.get("/saved-queries")
def list_saved(conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> list[SavedQueryOut]:
    rows = conn.execute(f"SELECT {_SAVED_COLS} FROM qlens.saved_queries WHERE workspace_id = %s "
                        "ORDER BY lower(title), id", (ws.id,)).fetchall()
    return [SavedQueryOut(**r) for r in rows]


@router.post("/saved-queries", status_code=201)
def create_saved(body: SavedQueryIn, conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> SavedQueryOut:
    row = conn.execute(
        f"INSERT INTO qlens.saved_queries (workspace_id, title, sql_text) VALUES (%s, %s, %s) "
        f"ON CONFLICT (workspace_id, title) DO NOTHING RETURNING {_SAVED_COLS}",
        (ws.id, body.title, body.sql_text)).fetchone()
    if row is None:
        raise ApiError(409, "title_taken", "You already have a saved query with this title.")
    return SavedQueryOut(**row)


@router.patch("/saved-queries/{sq_id}")
def update_saved(sq_id: int, body: SavedQueryPatch, conn: db.Conn,
                 ws: WorkspaceRow = Depends(owned_workspace)) -> SavedQueryOut:
    _require_saved_query(conn, ws.id, sq_id)
    try:
        row = conn.execute(
            f"UPDATE qlens.saved_queries SET title = COALESCE(%s, title), sql_text = COALESCE(%s, sql_text) "
            f"WHERE id = %s AND workspace_id = %s RETURNING {_SAVED_COLS}",
            (body.title, body.sql_text, sq_id, ws.id)).fetchone()
    except psycopg.errors.UniqueViolation:
        raise ApiError(409, "title_taken", "You already have a saved query with this title.") from None
    return SavedQueryOut(**row)


@router.delete("/saved-queries/{sq_id}", status_code=204)
def delete_saved(sq_id: int, conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> Response:
    _require_saved_query(conn, ws.id, sq_id)
    conn.execute("DELETE FROM qlens.saved_queries WHERE id = %s AND workspace_id = %s", (sq_id, ws.id))
    return Response(status_code=204)


@router.get("/saved-queries/{sq_id}/trend")
def trend(sq_id: int, conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> list[TrendPoint]:
    _require_saved_query(conn, ws.id, sq_id)
    rows = conn.execute(
        "SELECT run_id, run_number, created_at, duration_ms, prev_ms, moving_avg_ms "
        "FROM qlens.v_saved_query_trend WHERE saved_query_id = %s ORDER BY run_number", (sq_id,)).fetchall()
    return [TrendPoint(**r) for r in rows]
