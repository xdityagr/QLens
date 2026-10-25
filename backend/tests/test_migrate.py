def test_migrations_are_recorded_and_idempotent(conn):
    from qlens.migrate import apply_migrations
    assert apply_migrations(conn) == []          # already applied by fixture
    versions = [r["version"] for r in conn.execute("SELECT version FROM qlens.schema_migrations ORDER BY 1")]
    assert versions[0] == "000_bootstrap"


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json() == {"ok": True, "db": True}


def test_app_can_start_twice():
    # Regression: the lifespan used to reopen a closed module-level pool, which psycopg_pool forbids.
    from fastapi.testclient import TestClient
    from qlens.main import app
    # No `client` fixture: this exercises the real pool (dev DB) across two startups.
    for _ in range(2):
        with TestClient(app) as tc:
            assert tc.get("/api/health").json() == {"ok": True, "db": True}
