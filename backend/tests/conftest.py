import itertools
from dataclasses import dataclass

import psycopg
from psycopg import sql
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row

from qlens.auth import service as auth_service
from qlens.config import get_settings
from qlens.db import get_conn
from qlens.main import app
from qlens.migrate import apply_migrations
from qlens.workspaces.service import create_workspace

TEST_ROLE_PREFIX = "qlenstest_ws_"


@pytest.fixture(scope="session")
def test_url() -> str:
    return get_settings().test_database_url


@pytest.fixture(scope="session", autouse=True)
def _migrated(test_url):
    # Rebuild from scratch so edited migration files never meet a stale schema. qlens_app owns the schema.
    with psycopg.connect(test_url, row_factory=dict_row) as c:
        c.execute("DROP SCHEMA IF EXISTS qlens CASCADE")
        c.execute("CREATE SCHEMA qlens")
        c.execute("REVOKE ALL ON SCHEMA qlens FROM PUBLIC")
        c.commit()
        apply_migrations(c)


def _wipe(c: psycopg.Connection) -> None:
    # Workspace schemas/roles are created by tests; they must not leak between tests.
    # Guard: a misconfigured TEST_DATABASE_URL must never truncate the dev database.
    dbname = c.execute("SELECT current_database() AS d").fetchone()["d"]
    assert dbname == "qlens_test", f"refusing to wipe database {dbname!r}"
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
    # The sandbox connects to settings.pg_dbname (derived from database_url): point it at the test DB.
    monkeypatch.setattr(settings, "database_url", test_url)

    def override():
        with psycopg.connect(test_url, row_factory=dict_row) as c:
            yield c

    app.dependency_overrides[get_conn] = override
    with TestClient(app) as tc:
        yield tc
    app.dependency_overrides.clear()


@pytest.fixture
def second_client(client):
    # Independent cookie jar (a different user). Not entered with `with`: the lifespan already ran for
    # `client`, and the get_conn override it installs applies to every TestClient of the app.
    return TestClient(app)


# ---- workspace and sample-dataset fixtures --------------------------------------------------------

@dataclass
class WsHandle:
    id: int
    dataset_id: int | None = None


@pytest.fixture
def make_workspace(conn, monkeypatch, test_url):
    """Factory: every call makes a fresh user and a fresh workspace through the service layer.

    Committed, so other connections (the sandbox role, a TestClient) can see them; the `conn` fixture
    wipes every workspace schema, role and metadata row at the start of the next test.
    """
    monkeypatch.setattr(get_settings(), "role_prefix", TEST_ROLE_PREFIX)
    monkeypatch.setattr(get_settings(), "database_url", test_url)  # sandbox runs connect to the test DB
    made = itertools.count(1)

    def make() -> int:
        n = next(made)
        user = auth_service.signup(conn, auth_service.SignupIn(
            email=f"fixture{n}@example.com", password="fixture-password", display_name=f"Fixture {n}"))
        ws = create_workspace(conn, user.id, "Fixture workspace")
        conn.commit()
        return ws.id

    return make


@pytest.fixture
def workspace(make_workspace) -> int:
    return make_workspace()


def _with_sample(conn, ws_id: int, name: str) -> WsHandle:
    from qlens.ingest.stage import import_dataset
    from qlens.samples.generate import generate

    ds = import_dataset(conn, ws_id, *generate(name), source="sample")
    conn.commit()
    return WsHandle(id=ws_id, dataset_id=ds.id)


# Each sample fixture gets its own workspace (and user), so a test can request several of them.
@pytest.fixture
def fee_ws(conn, make_workspace) -> WsHandle:
    return _with_sample(conn, make_workspace(), "fee_register")


@pytest.fixture
def fee_ws_clean(conn, fee_ws) -> WsHandle:
    """fee_register after the one-click cleanup: duplicates merged, inconsistencies fixed, all FDs accepted."""
    from qlens.analysis.cleanup import accept_all

    accept_all(conn, fee_ws.dataset_id)
    conn.commit()
    return fee_ws


@pytest.fixture
def kirana_ws(conn, make_workspace) -> WsHandle:
    return _with_sample(conn, make_workspace(), "kirana_sales")


@pytest.fixture
def hostel_ws(conn, make_workspace) -> WsHandle:
    return _with_sample(conn, make_workspace(), "hostel_mess")


@pytest.fixture
def staged_tiny(conn) -> tuple[str, str]:
    """(schema, table) of a 4-row table a,b: (1,x),(1,x),(1,y),(2,z). Dropped by the next test's wipe."""
    conn.execute("CREATE SCHEMA ws_tiny_src")
    conn.execute("CREATE TABLE ws_tiny_src._staging (_row_id bigint PRIMARY KEY, a bigint, b text)")
    conn.execute("INSERT INTO ws_tiny_src._staging VALUES (1, 1, 'x'), (2, 1, 'x'), (3, 1, 'y'), (4, 2, 'z')")
    return "ws_tiny_src", "_staging"


@pytest.fixture
def applied_fee(conn, fee_ws_clean) -> WsHandle:
    """fee_register cleaned, designed and applied: ws_<id> holds students, batches, teachers, fee_register."""
    from qlens.design.apply import apply_proposal
    from qlens.design.proposal import build

    apply_proposal(conn, fee_ws_clean.id, build(conn, fee_ws_clean.dataset_id).id)
    conn.commit()
    return fee_ws_clean


@pytest.fixture
def other_applied_ws(conn, make_workspace) -> WsHandle:
    """A second user's applied fee_register workspace, for cross-workspace isolation tests."""
    from qlens.analysis.cleanup import accept_all
    from qlens.design.apply import apply_proposal
    from qlens.design.proposal import build

    ws = _with_sample(conn, make_workspace(), "fee_register")
    accept_all(conn, ws.dataset_id)
    apply_proposal(conn, ws.id, build(conn, ws.dataset_id).id)
    conn.commit()
    return ws


@pytest.fixture
def applied_fee_scaled(conn, applied_fee) -> WsHandle:
    """applied_fee with its performance lab built and the fact table (fee_register) scaled x10: 30,000 rows."""
    from qlens.perf.lab import scale

    scale(conn, applied_fee.id, 10)
    conn.commit()
    return applied_fee
