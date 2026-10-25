import psycopg
from psycopg import sql
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row

from qlens.config import get_settings
from qlens.db import get_conn
from qlens.main import app
from qlens.migrate import apply_migrations

TEST_ROLE_PREFIX = "qlenstest_ws_"


@pytest.fixture(scope="session")
def test_url() -> str:
    return get_settings().test_database_url


@pytest.fixture(scope="session", autouse=True)
def _migrated(test_url):
    with psycopg.connect(test_url, row_factory=dict_row) as c:
        apply_migrations(c)


def _wipe(c: psycopg.Connection) -> None:
    # Workspace schemas/roles are created by tests; they must not leak between tests.
    schemas = [r["nspname"] for r in c.execute(
        r"SELECT nspname FROM pg_namespace WHERE nspname LIKE 'ws\_%'")]
    for s in schemas:
        c.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(s)))
    roles = [r["rolname"] for r in c.execute(
        r"SELECT rolname FROM pg_roles WHERE rolname LIKE 'qlenstest\_ws\_%'")]
    for r in roles:
        # PG16+: a CREATEROLE creator has ADMIN but not INHERIT on the roles it made, and
        # DROP OWNED needs the role's privileges, so grant them to ourselves first.
        c.execute(sql.SQL("GRANT {} TO CURRENT_USER WITH INHERIT TRUE").format(sql.Identifier(r)))
        c.execute(sql.SQL("DROP OWNED BY {}").format(sql.Identifier(r)))
        c.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(r)))
    tables = [r["tablename"] for r in c.execute(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'qlens' AND tablename <> 'schema_migrations'")]
    if tables:
        idents = sql.SQL(", ").join(
            sql.SQL("qlens.{}").format(sql.Identifier(t)) for t in tables)
        c.execute(sql.SQL("TRUNCATE {} RESTART IDENTITY CASCADE").format(idents))
    c.commit()


@pytest.fixture
def conn(test_url):
    with psycopg.connect(test_url, row_factory=dict_row) as c:
        _wipe(c)
        yield c
        c.rollback()


@pytest.fixture
def client(test_url, conn, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "role_prefix", TEST_ROLE_PREFIX)

    def override():
        with psycopg.connect(test_url, row_factory=dict_row) as c:
            yield c

    app.dependency_overrides[get_conn] = override
    with TestClient(app) as tc:
        yield tc
    app.dependency_overrides.clear()
