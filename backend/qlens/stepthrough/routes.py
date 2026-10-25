from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from qlens import db
from qlens.auth.deps import owned_workspace
from qlens.errors import ApiError
from qlens.query.routes import SqlText, record_run
from qlens.query.sandbox import QueryError, QueryResult
from qlens.query.validate import validate_select
from qlens.stepthrough.stages import StageOut, run_stages
from qlens.workspaces.service import WorkspaceRow

router = APIRouter(prefix="/workspaces/{workspace_id}", tags=["stepthrough"])


class StepThroughIn(BaseModel):
    sql: SqlText


@router.post("/stepthrough")
def stepthrough(body: StepThroughIn, conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> list[StageOut]:
    sql_text, outcome = body.sql, None
    try:
        try:
            sql_text = validate_select(body.sql)
            stages = run_stages(ws.id, sql_text)
        except (ApiError, QueryError):
            raise
        except Exception:  # noqa: BLE001 - as in /query: whatever the checker or deparser chokes on gets a plain answer
            raise ApiError(422, "stepthrough_unsupported",
                           "This query could not be split into stages. Simplify it and try again.") from None
    except (ApiError, QueryError) as e:
        outcome = e
    if outcome is None:
        # One history row per request, for the user's own SQL: its row count, and the time of the final stage
        # (which is the whole query).
        last = stages[-1]
        record_run(conn, ws.id, sql_text, "stepthrough", "main", QueryResult(
            columns=last.columns, rows=[], row_count=last.row_count, truncated=False, duration_ms=last.duration_ms))
        return stages
    record_run(conn, ws.id, sql_text, "stepthrough", "main", outcome)
    status = outcome.status if isinstance(outcome, ApiError) else 400
    detail = {"sqlstate": outcome.sqlstate, "position": None} if isinstance(outcome, QueryError) else outcome.detail
    # Returned, not raised: raising would roll back the request transaction and lose the history row.
    return JSONResponse(status_code=status, content={
        "error": {"code": outcome.code, "message": outcome.message, "detail": detail}})
