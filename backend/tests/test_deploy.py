"""Production settings: config from the environment, the single-origin web app, cookie flags, cloud_init."""
import psycopg
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from psycopg.rows import dict_row

from qlens import cloud_init, db
from qlens.config import Settings, get_settings
from qlens.web import mount_frontend

SIGNUP = {"email": "deploy@example.com", "password": "deploy-password", "display_name": "Deploy"}


def _settings(**kw) -> Settings:
    return Settings(_env_file=None, secret_key="k", **kw)


# ---- config ---------------------------------------------------------------------------------------

def test_database_url_scheme_and_parts():
    s = _settings(database_url="postgres://u:p@db.example.com:6543/appdb?sslmode=require")
    assert s.database_url == "postgresql://u:p@db.example.com:6543/appdb?sslmode=require"
    assert (s.pg_host, s.pg_port, s.pg_dbname) == ("db.example.com", 6543, "appdb")
    assert _settings(database_url="postgresql://u@h/d").pg_port == 5432


def test_production_flags_from_env(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("COOKIE_SECURE", "true")
    monkeypatch.setenv("COOKIE_SAMESITE", "None")
    s = _settings(database_url="postgresql://u@h/d")
    assert s.is_production and s.cookie_is_secure and s.cookie_samesite == "none"
    assert s.test_database_url is None   # not needed outside the test suite
    assert not _settings(database_url="postgresql://u@h/d", app_env="development").is_production


def test_sandbox_params_follow_database_url(monkeypatch):
    monkeypatch.setattr(get_settings(), "database_url",
                        "postgresql://owner:pw@ep-x.example.com:5433/appdb?sslmode=require&options=endpoint%3Dep-x")
    p = db.ws_conn_params(7, "ws_7,ws_7_src", connect_timeout=5)
    assert (p["host"], p["port"], p["dbname"], p["sslmode"]) == ("ep-x.example.com", "5433", "appdb", "require")
    assert p["user"] == db.ws_role(7) and p["password"] == db.ws_password(7)
    assert p["options"] == "endpoint=ep-x -c search_path=ws_7,ws_7_src"
    assert p["connect_timeout"] == 5


# ---- cookie ---------------------------------------------------------------------------------------

def test_cookie_secure_in_production(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "cookie_secure", True)
    cookie = client.post("/api/auth/signup", json=SIGNUP).headers["set-cookie"].lower()
    assert "secure" in cookie and "samesite=lax" in cookie and "httponly" in cookie


def test_cookie_samesite_none_forces_secure(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "cookie_samesite", "none")
    cookie = client.post("/api/auth/signup", json=SIGNUP).headers["set-cookie"].lower()
    assert "samesite=none" in cookie and "secure" in cookie
    out = client.post("/api/auth/logout").headers["set-cookie"].lower()
    assert "samesite=none" in out and "secure" in out


def test_local_cookie_is_not_secure(client):
    cookie = client.post("/api/auth/signup", json=SIGNUP).headers["set-cookie"].lower()
    assert "secure" not in cookie


# ---- single-origin web app ------------------------------------------------------------------------

@pytest.fixture
def web(tmp_path) -> TestClient:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><div id=root></div>", encoding="utf-8")
    (dist / "favicon.svg").write_text("<svg/>", encoding="utf-8")
    (dist / "assets" / "index-abc123.js").write_text("console.log(1)", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("outside dist", encoding="utf-8")
    app = FastAPI()

    @app.get("/api/health")
    def health() -> dict:
        return {"ok": True}

    mount_frontend(app, dist)
    return TestClient(app)


def test_spa_serves_index_assets_and_deep_links(web):
    for path in ("/", "/login", "/w/1/data", "/w/1/data?tab=sql"):
        r = web.get(path)
        assert r.status_code == 200 and "id=root" in r.text, path
        assert r.headers["content-type"].startswith("text/html")
        assert r.headers["cache-control"] == "no-cache"
    assert web.get("/favicon.svg").text == "<svg/>"
    a = web.get("/assets/index-abc123.js")
    assert a.status_code == 200 and "immutable" in a.headers["cache-control"]
    assert web.get("/api/health").json() == {"ok": True}


def test_spa_unknown_api_path_is_json_404(web):
    for path in ("/api", "/api/nope", "/api/workspaces/1/nope"):
        r = web.get(path)
        assert r.status_code == 404 and r.json()["error"]["code"] == "not_found", path


def test_spa_never_serves_files_outside_dist(web):
    for path in ("/../secret.txt", "/%2e%2e/secret.txt", "/assets/../../secret.txt"):
        r = web.get(path)
        assert "outside dist" not in r.text, path


def test_spa_missing_build_fails_fast(tmp_path):
    with pytest.raises(RuntimeError, match="npm run build"):
        mount_frontend(FastAPI(), tmp_path / "nope")


# ---- cloud_init -----------------------------------------------------------------------------------

def test_cloud_init_is_idempotent(conn, test_url, monkeypatch, capsys):
    monkeypatch.setattr(get_settings(), "database_url", test_url)
    cloud_init.main()
    cloud_init.main()
    assert "none pending" in capsys.readouterr().out
    assert conn.execute("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'").fetchone()
    public_acl = conn.execute("SELECT has_schema_privilege('public', 'qlens', 'USAGE') AS u").fetchone()
    assert public_acl["u"] is False


def test_cloud_init_refuses_a_user_without_createrole(workspace):
    # A workspace role is exactly such a user: LOGIN, no CREATEROLE.
    with psycopg.connect(**db.ws_conn_params(workspace), row_factory=dict_row) as c:
        with pytest.raises(SystemExit, match="rolcreaterole"):
            cloud_init.check_createrole(c)
