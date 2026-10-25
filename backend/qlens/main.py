from contextlib import asynccontextmanager

import psycopg
from fastapi import APIRouter, Depends, FastAPI

from qlens import db
from qlens.errors import install_error_handlers


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
def health(conn: psycopg.Connection = Depends(db.get_conn)) -> dict:
    conn.execute("SELECT 1")
    return {"ok": True, "db": True}


app.include_router(router)
