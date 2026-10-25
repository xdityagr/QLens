from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI

from qlens import db
from qlens.analysis.routes import router as analysis_router
from qlens.auth.routes import router as auth_router
from qlens.errors import install_error_handlers
from qlens.ingest.routes import router as ingest_router
from qlens.workspaces.routes import router as workspaces_router


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.open_pool()
    try:
        yield
    finally:
        db.close_pool()


app = FastAPI(title="QLens", lifespan=lifespan)
install_error_handlers(app)

router = APIRouter(prefix="/api")


@router.get("/health")
def health(conn: db.Conn) -> dict:
    conn.execute("SELECT 1")
    return {"ok": True, "db": True}


router.include_router(auth_router)
router.include_router(workspaces_router)
router.include_router(ingest_router)
router.include_router(analysis_router)
app.include_router(router)
