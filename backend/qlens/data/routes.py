from typing import Literal

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel

from qlens import db
from qlens.auth.deps import owned_workspace
from qlens.data import service
from qlens.data.service import ChangesOut, Filter, OptionOut, RelatedOut, RowsOut, Value
from qlens.workspaces.service import WorkspaceRow

router = APIRouter(prefix="/workspaces/{workspace_id}", tags=["data"])


class RowIn(BaseModel):
    values: dict[str, Value]


# 100,000 pages of at least one row covers any table an import can make; past it OFFSET only
# overflows (a 500), so the API refuses it.
MAX_PAGE = 100_000
# Column filters: repeated ?f=column:op:value (op: eq, contains, gt, lt, empty), ANDed together.
Filters = Query([], max_length=20)


@router.get("/data/{table}")
def list_rows(table: str, conn: db.Conn, page: int = Query(1, ge=1, le=MAX_PAGE), page_size: int = Query(25, ge=1, le=100),
              sort: str | None = None, dir: Literal["asc", "desc"] = "asc", q: str = Query("", max_length=200),
              f: list[str] = Filters, ws: WorkspaceRow = Depends(owned_workspace)) -> RowsOut:
    return service.list_rows(conn, ws.id, table, page, page_size, sort, dir, q, [Filter.parse(x) for x in f])


@router.get("/data/{table}/export")
def export_csv(table: str, conn: db.Conn, sort: str | None = None, dir: Literal["asc", "desc"] = "asc",
               q: str = Query("", max_length=200), f: list[str] = Filters,
               ws: WorkspaceRow = Depends(owned_workspace)) -> Response:
    body, truncated = service.export_csv(conn, ws.id, table, sort, dir, q, [Filter.parse(x) for x in f])
    # The name was checked against the catalog by export_csv, so it is safe in the header.
    headers = {"Content-Disposition": f'attachment; filename="{table}.csv"'}
    if truncated:   # the file holds only the first EXPORT_LIMIT rows; the UI can say so
        headers["X-QLens-Truncated"] = "true"
    return Response(body, media_type="text/csv; charset=utf-8", headers=headers)


@router.get("/data/{table}/{row_id}/related")
def related(table: str, row_id: int, conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> list[RelatedOut]:
    return service.related(conn, ws.id, table, row_id)


@router.get("/data/{table}/options/{column}")
def fk_options(table: str, column: str, conn: db.Conn, q: str = Query("", max_length=200),
               ws: WorkspaceRow = Depends(owned_workspace)) -> list[OptionOut]:
    return service.fk_options(conn, ws.id, table, column, q)


@router.post("/data/{table}", status_code=201)
def insert_row(table: str, body: RowIn, conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> dict:
    return service.insert_row(conn, ws.id, table, body.values)


@router.patch("/data/{table}/{row_id}")
def update_row(table: str, row_id: int, body: RowIn, conn: db.Conn,
               ws: WorkspaceRow = Depends(owned_workspace)) -> dict:
    return service.update_row(conn, ws.id, table, row_id, body.values)


@router.delete("/data/{table}/{row_id}", status_code=204)
def delete_row(table: str, row_id: int, conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> Response:
    service.delete_row(conn, ws.id, table, row_id)
    return Response(status_code=204)


@router.get("/data-changes")
def changes(conn: db.Conn, limit: int = Query(50, ge=1, le=200),
            ws: WorkspaceRow = Depends(owned_workspace)) -> ChangesOut:
    return service.changes(conn, ws.id, limit)
