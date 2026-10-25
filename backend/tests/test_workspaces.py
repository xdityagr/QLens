import hashlib
import hmac
from urllib.parse import urlsplit

import psycopg
import pytest
from psycopg.rows import dict_row

from qlens import db
from qlens.config import get_settings

CREDS = {"email": "riya@x.com", "password": "correct horse", "display_name": "Riya"}
OTHER = {"email": "dev@x.com", "password": "another pass", "display_name": "Dev"}


@pytest.fixture
def user(client):
    client.post("/api/auth/signup", json=CREDS)
    return client


@pytest.fixture
def user_b(second_client):
    second_client.post("/api/auth/signup", json=OTHER)
    return second_client


def ws_conn(test_url, ws_id):
    """Connect the way the sandbox will: as the workspace's own role."""
    s = get_settings()
    password = hmac.new(s.secret_key.encode(), f"ws:{ws_id}".encode(), hashlib.sha256).hexdigest()
    return psycopg.connect(host=s.pg_host, port=s.pg_port, dbname=urlsplit(test_url).path.lstrip("/"),
                           user=f"qlenstest_ws_{ws_id}", password=password, row_factory=dict_row)


def test_workspaces_require_login(client):
    for method, path in (("get", "/api/workspaces"), ("post", "/api/workspaces"), ("get", "/api/workspaces/1"),
                         ("delete", "/api/workspaces/1")):
        r = getattr(client, method)(path)
        assert r.status_code == 401, path
        assert r.json()["error"]["code"] == "not_authenticated"


def test_workspace_crud_and_isolation(user, user_b):
    r = user.post("/api/workspaces", json={"name": "Fees"})
    assert r.status_code == 201
    ws = r.json()
    assert ws["name"] == "Fees" and ws["stage"] == "empty" and ws["query_count"] == 0
    assert set(ws) == {"id", "name", "created_at", "stage", "row_count", "column_count", "table_count",
                       "query_count", "last_activity_at"}
    # No dataset yet: the frontend relies on null, not 0
    assert ws["row_count"] is None and ws["column_count"] is None and ws["table_count"] is None

    assert user.get(f"/api/workspaces/{ws['id']}").json() == ws
    assert user.get("/api/workspaces").json() == [ws]

    # user B sees nothing of A's workspace
    assert user_b.get("/api/workspaces").json() == []
    for r in (user_b.get(f"/api/workspaces/{ws['id']}"), user_b.delete(f"/api/workspaces/{ws['id']}")):
        assert r.status_code == 404
        assert r.json()["error"]["code"] == "workspace_not_found"
    assert user.get(f"/api/workspaces/{ws['id']}").status_code == 200

    assert user.delete(f"/api/workspaces/{ws['id']}").status_code == 204
    assert user.get(f"/api/workspaces/{ws['id']}").status_code == 404
    assert user.get("/api/workspaces").json() == []


def test_missing_workspace_404(user):
    r = user.get("/api/workspaces/99999")
    assert r.status_code == 404 and r.json()["error"]["code"] == "workspace_not_found"


def test_workspace_name_unique_per_owner(user, user_b, conn):
    assert user.post("/api/workspaces", json={"name": "Fees"}).status_code == 201
    r = user.post("/api/workspaces", json={"name": "Fees"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "workspace_name_taken"
    # the failed create must not leave a role behind, and another user may reuse the name
    assert conn.execute("SELECT count(*) AS n FROM pg_roles WHERE rolname LIKE 'qlenstest\\_ws\\_%'"
                        ).fetchone()["n"] == 1
    assert user_b.post("/api/workspaces", json={"name": "Fees"}).status_code == 201
    assert len(user.get("/api/workspaces").json()) == 1


def test_workspace_name_validation(user):
    for bad in ({"name": ""}, {"name": "   "}, {"name": "x" * 61}, {}):
        r = user.post("/api/workspaces", json=bad)
        assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error", bad


def test_list_ordered_by_last_activity_desc(user, conn):
    a = user.post("/api/workspaces", json={"name": "A"}).json()
    user.post("/api/workspaces", json={"name": "B"})
    assert [w["name"] for w in user.get("/api/workspaces").json()] == ["B", "A"]
    conn.execute("UPDATE qlens.workspaces SET name = 'A2' WHERE id = %s", (a["id"],))  # touch trigger
    conn.commit()
    assert [w["name"] for w in user.get("/api/workspaces").json()] == ["A2", "B"]


def test_create_workspace_creates_role_and_schemas(client, conn):
    client.post("/api/auth/signup", json=CREDS)
    ws = client.post("/api/workspaces", json={"name": "Fees"}).json()
    roles = conn.execute("SELECT rolname FROM pg_roles WHERE rolname = %s", (f"qlenstest_ws_{ws['id']}",)).fetchall()
    schemas = {r["nspname"] for r in conn.execute("SELECT nspname FROM pg_namespace WHERE nspname LIKE %s",
                                                  (f"ws_{ws['id']}%",))}
    assert len(roles) == 1 and schemas == {f"ws_{ws['id']}", f"ws_{ws['id']}_src"}


def test_workspace_role_is_locked_down(user, conn, test_url):
    ws = user.post("/api/workspaces", json={"name": "Fees"}).json()
    i = ws["id"]
    role = conn.execute(
        "SELECT rolcanlogin, rolinherit, rolsuper, rolcreaterole, rolcreatedb, rolconnlimit, rolconfig "
        "FROM pg_roles WHERE rolname = %s", (f"qlenstest_ws_{i}",)).fetchone()
    assert role["rolcanlogin"] and not role["rolinherit"] and not role["rolsuper"]
    assert not role["rolcreaterole"] and not role["rolcreatedb"] and role["rolconnlimit"] == 3
    cfg = set(role["rolconfig"])
    assert {"statement_timeout=5s", "default_transaction_read_only=on",
            "idle_in_transaction_session_timeout=10s", f"search_path=ws_{i}, ws_{i}_src"} <= cfg

    # a table the app creates later is readable by the role (default privileges), but nothing is writable
    conn.execute(f"CREATE TABLE ws_{i}.fee (id int, amount int)")
    conn.execute(f"INSERT INTO ws_{i}.fee VALUES (1, 100)")
    conn.execute(f"CREATE TABLE ws_{i}_src.raw (v int)")
    conn.commit()
    with ws_conn(test_url, i) as w:
        assert w.execute("SHOW search_path").fetchone()["search_path"] == f"ws_{i}, ws_{i}_src"
        assert w.execute("SELECT amount FROM fee").fetchall() == [{"amount": 100}]  # via search_path
        assert w.execute("SELECT count(*) AS n FROM raw").fetchone()["n"] == 0
        for stmt in ("INSERT INTO fee VALUES (2, 3)", f"CREATE TABLE ws_{i}.evil (a int)",
                     "CREATE TABLE public.evil (a int)", "SELECT * FROM qlens.users"):
            with pytest.raises(psycopg.Error):
                w.execute(stmt)
            w.rollback()


def test_delete_workspace_drops_role(user, conn):
    ws = user.post("/api/workspaces", json={"name": "Fees"}).json()
    i = ws["id"]
    conn.execute(f"CREATE TABLE ws_{i}.t (a int)")  # content must not block the drop
    conn.commit()
    assert user.delete(f"/api/workspaces/{i}").status_code == 204
    assert conn.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (f"qlenstest_ws_{i}",)).fetchall() == []
    assert conn.execute("SELECT 1 FROM pg_namespace WHERE nspname LIKE %s", (f"ws\\_{i}%",)).fetchall() == []
    assert conn.execute("SELECT 1 FROM qlens.workspaces WHERE id = %s", (i,)).fetchall() == []


def test_db_naming_helpers(client):
    s = get_settings()
    assert db.ws_schema(7, "main") == "ws_7"
    assert db.ws_schema(7, "src") == "ws_7_src"
    assert db.ws_schema(7, "lab") == "ws_7_lab"
    assert db.ws_role(7) == f"{s.role_prefix}7"
    expected = hmac.new(s.secret_key.encode(), b"ws:7", hashlib.sha256).hexdigest()
    assert db.ws_password(7) == expected


def test_lab_schema_helpers(user, conn):
    ws = user.post("/api/workspaces", json={"name": "Fees"}).json()
    i = ws["id"]
    db.create_ws_schema(conn, i, "lab")
    assert conn.execute("SELECT 1 FROM pg_namespace WHERE nspname = %s", (f"ws_{i}_lab",)).fetchall()
    db.drop_ws_schema(conn, i, "lab")
    assert not conn.execute("SELECT 1 FROM pg_namespace WHERE nspname = %s", (f"ws_{i}_lab",)).fetchall()
    conn.commit()
