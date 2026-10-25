import pytest

FIXTURE_USER = {"email": "fixture1@example.com", "password": "fixture-password"}  # owner of applied_fee


@pytest.fixture
def ws_id(client, applied_fee) -> int:
    assert client.post("/api/auth/login", json=FIXTURE_USER).status_code == 200
    return applied_fee.id


def _url(ws_id: int, path: str = "") -> str:
    return f"/api/workspaces/{ws_id}{path}"


def _save(client, ws_id, title="Count students", sql="SELECT count(*) AS n FROM students") -> dict:
    r = client.post(_url(ws_id, "/saved-queries"), json={"title": title, "sql_text": sql})
    assert r.status_code == 201, r.text
    return r.json()


def test_run_is_recorded_and_saved_stats(client, ws_id):
    sq = _save(client, ws_id)
    assert sq["run_count"] == 0 and sq["last_run_at"] is None
    for _ in range(2):
        r = client.post(_url(ws_id, "/query"), json={"sql": sq["sql_text"] + ";", "saved_query_id": sq["id"]})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["result"]["columns"] == [{"name": "n", "type": "bigint"}]
        assert body["result"]["row_count"] == 1 and body["result"]["truncated"] is False
    listed = client.get(_url(ws_id, "/saved-queries")).json()
    assert [(q["id"], q["run_count"]) for q in listed] == [(sq["id"], 2)]
    assert listed[0]["last_run_at"] is not None and listed[0]["last_duration_ms"] is not None
    history = client.get(_url(ws_id, "/history")).json()
    assert len(history) == 2 and all(h["status"] == "ok" and h["saved_query_id"] == sq["id"] for h in history)
    assert history[0]["id"] > history[1]["id"]
    assert history[0]["source"] == "typed" and history[0]["target"] == "main" and history[0]["row_count"] == 1
    assert history[0]["sql_text"] == "SELECT count(*) AS n FROM students"
    trend = client.get(_url(ws_id, f"/saved-queries/{sq['id']}/trend")).json()
    assert [t["run_number"] for t in trend] == [1, 2] and trend[0]["prev_ms"] is None
    assert trend[1]["prev_ms"] == pytest.approx(trend[0]["duration_ms"])
    assert client.get(_url(ws_id, "/slow-queries")).status_code == 200


def test_error_is_recorded(client, ws_id):
    r = client.post(_url(ws_id, "/query"), json={"sql": "SELECT nope FROM students"})
    assert r.status_code == 400
    err = r.json()["error"]
    assert err["code"] == "db_error" and "nope" in err["message"]
    assert err["detail"] == {"sqlstate": "42703", "position": 8}
    [h] = client.get(_url(ws_id, "/history")).json()
    assert h["status"] == "error" and "nope" in h["error_message"] and h["row_count"] is None


def test_timeout_is_recorded_and_does_not_count_for_saved_query(client, ws_id):
    sq = _save(client, ws_id, "Slow", "SELECT pg_sleep(10)")
    r = client.post(_url(ws_id, "/query"), json={"sql": sq["sql_text"], "saved_query_id": sq["id"]})
    assert r.status_code == 400 and r.json()["error"]["code"] == "timeout"
    [h] = client.get(_url(ws_id, "/history")).json()
    assert h["status"] == "timeout" and h["duration_ms"] is not None
    assert client.get(_url(ws_id, "/saved-queries")).json()[0]["run_count"] == 0


@pytest.mark.parametrize("sql,code", [
    ("DELETE FROM students", "not_a_select"),
    ("SELECT 1; SELECT 2", "multiple_statements"),
    ("SELECT set_config('role','x',false)", "forbidden_function"),
    ("SELEC 1", "syntax_error"),
])
def test_validation_errors_are_400_and_recorded(client, ws_id, sql, code):
    r = client.post(_url(ws_id, "/query"), json={"sql": sql})
    assert r.status_code == 400 and r.json()["error"]["code"] == code
    assert "position" in r.json()["error"]["detail"]
    [h] = client.get(_url(ws_id, "/history")).json()
    assert h["status"] == "error" and h["sql_text"] == sql


def test_lab_target_and_bad_target(client, ws_id):
    r = client.post(_url(ws_id, "/query"), json={"sql": "SELECT count(*) FROM students", "target": "lab"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "db_error"
    assert client.get(_url(ws_id, "/history")).json()[0]["target"] == "lab"
    assert client.post(_url(ws_id, "/query"), json={"sql": "SELECT 1", "target": "x"}).status_code == 422


def test_history_limit_and_order(client, ws_id):
    for i in range(3):
        client.post(_url(ws_id, "/query"), json={"sql": f"SELECT {i}"})
    h = client.get(_url(ws_id, "/history?limit=2")).json()
    assert [x["sql_text"] for x in h] == ["SELECT 2", "SELECT 1"]
    assert client.get(_url(ws_id, "/history?limit=0")).status_code == 422


def test_saved_query_crud(client, ws_id):
    a = _save(client, ws_id, "A")
    assert client.post(_url(ws_id, "/saved-queries"), json={"title": "A", "sql_text": "SELECT 2"}
                       ).json()["error"]["code"] == "title_taken"
    b = _save(client, ws_id, "B")
    r = client.patch(_url(ws_id, f"/saved-queries/{a['id']}"), json={"title": "A2", "sql_text": "SELECT 9"})
    assert r.status_code == 200 and r.json()["title"] == "A2" and r.json()["sql_text"] == "SELECT 9"
    r = client.patch(_url(ws_id, f"/saved-queries/{b['id']}"), json={"title": "A2"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "title_taken"
    assert client.patch(_url(ws_id, f"/saved-queries/{b['id']}"), json={"title": ""}).status_code == 422
    assert client.patch(_url(ws_id, "/saved-queries/99999"), json={"title": "Z"}).status_code == 404
    # deleting keeps the run history
    client.post(_url(ws_id, "/query"), json={"sql": "SELECT 1", "saved_query_id": b["id"]})
    assert client.delete(_url(ws_id, f"/saved-queries/{b['id']}")).status_code == 204
    assert client.delete(_url(ws_id, f"/saved-queries/{b['id']}")).status_code == 404
    assert [q["title"] for q in client.get(_url(ws_id, "/saved-queries")).json()] == ["A2"]
    assert client.get(_url(ws_id, "/history")).json()[0]["saved_query_id"] is None


def test_requires_login_and_ownership(client, second_client, ws_id, other_applied_ws):
    sq = _save(client, ws_id)
    reqs = [("post", "/query", {"json": {"sql": "SELECT 1"}}), ("get", "/history", {}),
            ("get", "/saved-queries", {}), ("get", "/slow-queries", {}),
            ("get", f"/saved-queries/{sq['id']}/trend", {}),
            ("patch", f"/saved-queries/{sq['id']}", {"json": {"title": "x"}}),
            ("delete", f"/saved-queries/{sq['id']}", {})]
    for method, path, kw in reqs:
        assert getattr(second_client, method)(_url(ws_id, path), **kw).status_code == 401
    # a logged-in user who does not own the workspace gets 404, as does a saved query of another workspace
    assert client.post(_url(other_applied_ws.id, "/query"), json={"sql": "SELECT 1"}).status_code == 404
    other_user = {"email": "fixture2@example.com", "password": "fixture-password"}
    assert second_client.post("/api/auth/login", json=other_user).status_code == 200
    r = second_client.post(_url(other_applied_ws.id, "/query"), json={"sql": "SELECT 1", "saved_query_id": sq["id"]})
    assert r.status_code == 404 and r.json()["error"]["code"] == "saved_query_not_found"
    for method, path, kw in reqs:
        assert getattr(second_client, method)(_url(ws_id, path), **kw).status_code == 404


def test_cross_workspace_read_is_a_recorded_db_error(client, ws_id, other_applied_ws):
    r = client.post(_url(ws_id, "/query"), json={"sql": f"SELECT * FROM ws_{other_applied_ws.id}.students"})
    assert r.status_code == 400 and r.json()["error"]["detail"]["sqlstate"] == "42501"
