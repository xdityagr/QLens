from fastapi import APIRouter, Depends
from pydantic import BaseModel

from qlens import db
from qlens.analysis import discover
from qlens.analysis.discover import AnalysisOut, FDOut
from qlens.auth.deps import owned_workspace
from qlens.errors import ApiError
from qlens.workspaces.service import WorkspaceRow

router = APIRouter(prefix="/workspaces/{workspace_id}", tags=["analysis"])


class FDPatch(BaseModel):
    accepted: bool


def _dataset(conn: db.Conn, ws: WorkspaceRow) -> dict:
    ds = conn.execute("SELECT id, status FROM qlens.datasets WHERE workspace_id = %s", (ws.id,)).fetchone()
    if ds is None:
        raise ApiError(404, "no_dataset", "This workspace has no dataset yet.")
    return ds


@router.post("/analyze")
def analyze(conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> AnalysisOut:
    # Sync endpoint: the discovery queries block and run in the threadpool.
    return discover.analyze(conn, _dataset(conn, ws)["id"])


@router.get("/analysis")
def get_analysis(conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> AnalysisOut:
    ds = _dataset(conn, ws)
    if ds["status"] == "imported":
        raise ApiError(404, "not_analyzed", "This dataset has not been analyzed yet.")
    return discover.get_analysis(conn, ds["id"])


@router.patch("/fds/{fd_id}")
def patch_fd(fd_id: int, body: FDPatch, conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> FDOut:
    ds = _dataset(conn, ws)
    # The dataset id in the WHERE clause keeps one workspace from touching another's dependencies.
    row = conn.execute("UPDATE qlens.functional_dependencies SET accepted = %s WHERE id = %s AND dataset_id = %s "
                       "RETURNING id", (body.accepted, fd_id, ds["id"])).fetchone()
    if row is None:
        raise ApiError(404, "fd_not_found", "Dependency not found.")
    return discover.load_fds(conn, ds["id"], fd_id)[0]
