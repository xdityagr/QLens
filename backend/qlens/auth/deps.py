import psycopg
from fastapi import Depends, Request

from qlens import db
from qlens.auth import service
from qlens.auth.service import UserOut
from qlens.errors import ApiError
from qlens.workspaces.service import WorkspaceRow, get_workspace_row


def current_user(request: Request, conn: psycopg.Connection = Depends(db.get_conn)) -> UserOut:
    token = request.cookies.get(service.SESSION_COOKIE)
    user = service.user_for_token(conn, token) if token else None
    if user is None:
        raise ApiError(401, "not_authenticated", "Log in to continue.")
    return user


def owned_workspace(
    workspace_id: int,
    user: UserOut = Depends(current_user),
    conn: psycopg.Connection = Depends(db.get_conn),
) -> WorkspaceRow:
    # Someone else's workspace is reported as missing so ids cannot be probed.
    row = get_workspace_row(conn, workspace_id, user.id)
    if row is None:
        raise ApiError(404, "workspace_not_found", "Workspace not found.")
    return row
