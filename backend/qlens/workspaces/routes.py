import psycopg
from fastapi import APIRouter, Depends, Response

from qlens import db
from qlens.auth.deps import current_user, owned_workspace
from qlens.auth.service import UserOut
from qlens.workspaces import service
from qlens.workspaces.service import WorkspaceIn, WorkspaceOut, WorkspaceRow

router = APIRouter(prefix="/workspaces", tags=["workspaces"])


@router.get("")
def list_workspaces(
    user: UserOut = Depends(current_user), conn: psycopg.Connection = Depends(db.get_conn)
) -> list[WorkspaceOut]:
    return service.list_workspaces(conn, user.id)


@router.post("", status_code=201)
def create_workspace(
    data: WorkspaceIn, user: UserOut = Depends(current_user), conn: psycopg.Connection = Depends(db.get_conn)
) -> WorkspaceOut:
    return service.create_workspace(conn, user.id, data.name)


@router.get("/{workspace_id}")
def get_workspace(
    ws: WorkspaceRow = Depends(owned_workspace), conn: psycopg.Connection = Depends(db.get_conn)
) -> WorkspaceOut:
    return service.get_workspace(conn, ws.id)


@router.delete("/{workspace_id}", status_code=204)
def delete_workspace(
    ws: WorkspaceRow = Depends(owned_workspace), conn: psycopg.Connection = Depends(db.get_conn)
) -> Response:
    service.delete_workspace(conn, ws.id)
    return Response(status_code=204)
