from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI

from qlens import db
from qlens.analysis.routes import router as analysis_router
from qlens.assistant.routes import router as assistant_router
from qlens.auth.routes import router as auth_router
from qlens.config import get_settings
from qlens.data.routes import router as data_router
from qlens.design.routes import router as design_router
from qlens.errors import install_error_handlers
from qlens.ingest.routes import router as ingest_router
from qlens.perf.routes import router as perf_router
from qlens.query.routes import router as query_router
from qlens.stepthrough.routes import router as stepthrough_router
from qlens.web import mount_frontend
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


@router.get("/config")
def config() -> dict:
    """What the UI may offer; no login needed, and never the key itself."""
    s = get_settings()
    enabled = bool(s.gemini_api_key)
    return {"assistant_enabled": enabled, "assistant_model": s.gemini_model if enabled else None}


router.include_router(auth_router)
router.include_router(workspaces_router)
router.include_router(ingest_router)
router.include_router(analysis_router)
router.include_router(design_router)
router.include_router(query_router)
router.include_router(assistant_router)
router.include_router(data_router)
router.include_router(perf_router)
router.include_router(stepthrough_router)
app.include_router(router)

# Last, so its catch-all route only sees paths the API did not match.
if get_settings().is_production:
    mount_frontend(app, get_settings().frontend_dist)
