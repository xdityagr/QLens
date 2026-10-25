from typing import Literal

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from qlens import db
from qlens.auth.deps import owned_workspace
from qlens.errors import ApiError
from qlens.perf import advisor, explain as plans, lab
from qlens.perf.advisor import IndexSuggestion
from qlens.perf.explain import PlanOut
from qlens.perf.lab import ExperimentOut, ExperimentRow, LabOut
from qlens.query.routes import SqlText, record_run
from qlens.query.sandbox import QueryError, QueryResult
from qlens.query.validate import validate_select
from qlens.workspaces.service import WorkspaceRow

router = APIRouter(prefix="/workspaces/{workspace_id}", tags=["perf"])


class ScaleIn(BaseModel):
    factor: int


class ExplainIn(BaseModel):
    sql: SqlText
    target: Literal["main", "lab"] = "main"


class ExplainOut(BaseModel):
    run_id: int
    plan: PlanOut
    suggestions: list[IndexSuggestion]


class TryIndexIn(BaseModel):
    sql: SqlText
    table: str
    columns: list[str]


def _checked(sql_text: str) -> str:
    try:
        return validate_select(sql_text)
    except ApiError:
        raise
    except Exception:  # noqa: BLE001 - as in /query: whatever the checker chokes on gets a plain answer
        raise ApiError(422, "invalid_query", "This query could not be checked. Simplify it and try again.",
                       detail={"position": None}) from None


def _error_response(e: ApiError | QueryError) -> JSONResponse:
    detail = {"sqlstate": e.sqlstate, "position": e.position} if isinstance(e, QueryError) else e.detail
    return JSONResponse(status_code=400, content={"error": {"code": e.code, "message": e.message, "detail": detail}})


@router.get("/lab")
def lab_status(conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> LabOut:
    return lab.status(conn, ws.id)


@router.post("/lab")
def lab_ensure(conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> LabOut:
    return lab.ensure_lab(conn, ws.id)


@router.post("/lab/reset")
def lab_reset(conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> LabOut:
    return lab.reset_lab(conn, ws.id)


@router.post("/lab/scale")
def lab_scale(body: ScaleIn, conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> LabOut:
    return lab.scale(conn, ws.id, body.factor)


@router.post("/explain")
def explain(body: ExplainIn, conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)):
    if body.target == "lab":
        lab.ensure_lab(conn, ws.id)  # a workspace without an applied design gets 409, not a failed run
    sql_text, outcome = body.sql, None
    try:
        sql_text = _checked(body.sql)
        outcome = plans.explain(conn, ws.id, sql_text, body.target)
    except (ApiError, QueryError) as e:
        outcome = e
    if not isinstance(outcome, PlanOut):
        record_run(conn, ws.id, sql_text, "perf", body.target, outcome)
        # Returned, not raised: raising would roll back the request transaction and lose the history row.
        return _error_response(outcome)
    root_rows = round(outcome.nodes[0].actual_rows * outcome.nodes[0].loops) if outcome.nodes else 0
    run_id = record_run(conn, ws.id, sql_text, "perf", body.target, QueryResult(
        columns=[], rows=[], row_count=root_rows, truncated=False, duration_ms=outcome.execution_ms))
    conn.execute("UPDATE qlens.explain_snapshots SET query_run_id = %s WHERE id = %s", (run_id, outcome.snapshot_id))
    return ExplainOut(run_id=run_id, plan=outcome, suggestions=advisor.suggest(conn, ws.id, outcome, body.target))


@router.post("/lab/try-index")
def try_index(body: TryIndexIn, conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> ExperimentOut:
    try:
        return lab.try_index(conn, ws.id, _checked(body.sql), body.table, body.columns)
    except QueryError as e:
        raise ApiError(400, e.code, e.message, detail={"sqlstate": e.sqlstate, "position": e.position}) from None


@router.get("/lab/experiments")
def experiments(conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> list[ExperimentRow]:
    return lab.list_experiments(conn, ws.id)


@router.delete("/lab/experiments/{exp_id}")
def drop_experiment(exp_id: int, conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> ExperimentRow:
    return lab.drop_index(conn, ws.id, exp_id)
