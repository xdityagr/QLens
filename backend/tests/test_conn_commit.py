"""The REAL db.get_conn (not the conftest override) must commit before the response is sent."""
import asyncio

import psycopg
import pytest
from fastapi import FastAPI

from qlens import db
from qlens.config import get_settings
from qlens.errors import ApiError, install_error_handlers

INSERT = "INSERT INTO qlens.users (email, password_hash, display_name) VALUES ('commit@x.com', 'x', 'C')"


@pytest.fixture
def real_pool_app(test_url, conn, monkeypatch):
    # Point the real pool at the isolated test DB; `conn` has already wiped it.
    monkeypatch.setattr(get_settings(), "database_url", test_url)
    app = FastAPI()
    install_error_handlers(app)

    @app.post("/ok")
    def ok(c: db.Conn) -> dict:
        c.execute(INSERT)
        return {"ok": True}

    @app.post("/boom")
    def boom(c: db.Conn) -> dict:
        c.execute(INSERT)
        raise ApiError(409, "boom", "fails after writing")

    db.open_pool()
    yield app
    db.close_pool()


def _post_and_observe(app, path, test_url):
    """Call the app at ASGI level; at the moment the status line is sent, count rows from another connection."""
    seen: dict = {}

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        if message["type"] == "http.response.start":
            seen["status"] = message["status"]
            with psycopg.connect(test_url) as other:
                seen["rows_at_response_start"] = other.execute("SELECT count(*) FROM qlens.users").fetchone()[0]

    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST",
             "scheme": "http", "path": path, "raw_path": path.encode(), "root_path": "", "query_string": b"",
             "headers": [], "client": ("test", 1), "server": ("test", 80)}
    asyncio.run(app(scope, receive, send))
    return seen


def test_write_is_committed_before_response_is_sent(real_pool_app, test_url):
    seen = _post_and_observe(real_pool_app, "/ok", test_url)
    assert seen["status"] == 200
    assert seen["rows_at_response_start"] == 1


def test_failed_request_rolls_back(real_pool_app, test_url):
    seen = _post_and_observe(real_pool_app, "/boom", test_url)
    assert seen["status"] == 409
    assert seen["rows_at_response_start"] == 0
    with psycopg.connect(test_url) as other:
        assert other.execute("SELECT count(*) FROM qlens.users").fetchone()[0] == 0
