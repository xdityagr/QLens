
from fastapi import APIRouter, Depends, UploadFile
from pydantic import BaseModel

from qlens import db
from qlens.auth.deps import owned_workspace
from qlens.errors import ApiError
from qlens.ingest import stage
from qlens.ingest.parse import MAX_BYTES
from qlens.ingest.stage import DatasetDetailOut, DatasetOut
from qlens.samples.generate import SampleName, generate
from qlens.workspaces.service import WorkspaceRow

router = APIRouter(prefix="/workspaces/{workspace_id}/dataset", tags=["dataset"])


class SampleIn(BaseModel):
    name: SampleName


@router.post("", status_code=201)
def upload_dataset(file: UploadFile, conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> DatasetOut:
    # Sync endpoint on purpose: parsing and the import are blocking work and run in the threadpool.
    # Read one byte past the limit so an oversized file is detected without reading it all.
    data = file.file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ApiError(422, "file_too_large", "The file is larger than 20 MB.")
    return stage.import_dataset(conn, ws.id, file.filename or "upload", data, source="upload")


@router.post("/sample", status_code=201)
def import_sample(body: SampleIn, conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> DatasetOut:
    filename, data = generate(body.name)
    return stage.import_dataset(conn, ws.id, filename, data, source="sample")


@router.get("")
def get_dataset(conn: db.Conn, ws: WorkspaceRow = Depends(owned_workspace)) -> DatasetDetailOut:
    detail = stage.get_dataset_detail(conn, ws.id)
    if detail is None:
        raise ApiError(404, "no_dataset", "This workspace has no dataset yet.")
    return detail
