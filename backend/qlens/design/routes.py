from fastapi import APIRouter, Depends
from pydantic import BaseModel

from qlens import db
from qlens.auth.deps import owned_workspace
from qlens.design import ddl, proposal
from qlens.design.proposal import ProposalOut
from qlens.errors import ApiError
from qlens.workspaces.service import WorkspaceRow

router = APIRouter(prefix="/workspaces/{workspace_id}/proposal", tags=["design"])


class RenameIn(BaseModel):
    name: str


class SqlOut(BaseModel):
    sql: str


def _dataset_id(conn: db.Conn, ws: WorkspaceRow) -> int:
    ds = conn.execute("SELECT id FROM qlens.datasets WHERE workspace_id = %s", (ws.id,)).fetchone()
    if ds is None:
        raise ApiError(404, "no_dataset", "This workspace has no dataset yet.")
    return ds["id"]


def _live(conn: db.Conn, ws: WorkspaceRow) -> ProposalOut:
    p = proposal.live_proposal(conn, _dataset_id(conn, ws))
    if p is None:
        raise ApiError(404, "no_proposal", "No design has been proposed for this dataset yet.")
    return p


@router.post("")
def build(conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> ProposalOut:
    return proposal.build(conn, _dataset_id(conn, ws))


@router.get("")
def get(conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> ProposalOut:
    return _live(conn, ws)


@router.patch("/tables/{table_id}")
def rename_table(table_id: int, body: RenameIn, conn: db.Conn,
                 ws: WorkspaceRow = Depends(owned_workspace)) -> ProposalOut:
    return proposal.rename_table(conn, _dataset_id(conn, ws), table_id, body.name)


@router.patch("/columns/{column_id}")
def rename_column(column_id: int, body: RenameIn, conn: db.Conn,
                  ws: WorkspaceRow = Depends(owned_workspace)) -> ProposalOut:
    return proposal.rename_column(conn, _dataset_id(conn, ws), column_id, body.name)


@router.get("/sql")
def get_sql(conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> SqlOut:
    return SqlOut(sql=ddl.as_text(ddl.render(_live(conn, ws), ws.id), conn))
