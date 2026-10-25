from fastapi import APIRouter, Depends
from pydantic import BaseModel

from qlens import db
from qlens.analysis import cleanup, discover
from qlens.analysis.discover import AnalysisOut, FDOut
from qlens.auth.deps import owned_workspace
from qlens.errors import ApiError
from qlens.workspaces.service import WorkspaceRow

router = APIRouter(prefix="/workspaces/{workspace_id}", tags=["analysis"])


class FDPatch(BaseModel):
    accepted: bool


class MergeIn(BaseModel):
    canonical: str | None = None


class FixIn(BaseModel):
    # json.dumps(lhs_values) of a conflicting group -> the RHS value to write there instead of the suggestion.
    overrides: dict[str, str] | None = None


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


# The cleanup routes change _staging, so each one re-runs the analysis (in the same transaction) and
# returns it: dependencies and duplicate groups may look different once the data is cleaner.

@router.post("/duplicates/{group_id}/merge")
def merge_duplicates(group_id: int, body: MergeIn, conn: db.Conn,
                     ws: WorkspaceRow = Depends(owned_workspace)) -> AnalysisOut:
    ds = _dataset(conn, ws)["id"]
    with conn.transaction():
        cleanup.merge_group(conn, ds, group_id, body.canonical)
        return discover.analyze(conn, ds)


@router.post("/duplicates/{group_id}/dismiss")
def dismiss_duplicates(group_id: int, conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> AnalysisOut:
    ds = _dataset(conn, ws)["id"]
    cleanup.dismiss_group(conn, ds, group_id)
    return discover.get_analysis(conn, ds)


@router.post("/inconsistencies/{fd_id}/fix")
def fix_inconsistency(fd_id: int, body: FixIn, conn: db.Conn,
                      ws: WorkspaceRow = Depends(owned_workspace)) -> AnalysisOut:
    ds = _dataset(conn, ws)["id"]
    with conn.transaction():
        cleanup.fix_fd(conn, ds, fd_id, body.overrides)
        return discover.analyze(conn, ds)


@router.post("/cleanup/accept-all")
def accept_all(conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> AnalysisOut:
    return cleanup.accept_all(conn, _dataset(conn, ws)["id"])


@router.get("/fixes")
def fixes(conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> list[cleanup.FixOut]:
    return cleanup.list_fixes(conn, _dataset(conn, ws)["id"])
