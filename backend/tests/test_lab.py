import pytest

from qlens import db
from qlens.design import catalog
from qlens.errors import ApiError
from qlens.perf.lab import drop_index, ensure_lab, list_experiments, reset_lab, scale, status, try_index
from qlens.query import sandbox

FIXTURE_USER = {"email": "fixture1@example.com", "password": "fixture-password"}  # owner of applied_fee
QUERY = "SELECT * FROM fee_register WHERE student_id = 5"


def fact_rows(lab) -> int:
    return next(t["row_count"] for t in lab.tables if t["name"] == "fee_register")


def test_lab_copy_has_no_secondary_indexes(conn, applied_fee):
    lab = ensure_lab(conn, applied_fee.id)
    main = catalog.describe(conn, applied_fee.id, "main")
    assert lab.scale_factor == 1
    assert [(t["name"], t["row_count"]) for t in lab.tables] == [(t["name"], t["row_count"]) for t in main.tables]
    assert [t["color_index"] for t in lab.tables] == [t["color_index"] for t in main.tables]
    for t in lab.tables:
        assert t["indexes"] == [{"name": f"{t['name']}_pkey", "columns": ["id"]}]
    schema = db.ws_schema(applied_fee.id, "lab")
    # No unique or foreign-key constraints and no triggers came across; the copy is readable by the sandbox role.
    assert conn.execute("SELECT count(*) AS n FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace "
                        "WHERE n.nspname = %s AND k.contype IN ('u', 'f')", (schema,)).fetchone()["n"] == 0
    assert conn.execute("SELECT count(*) AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid "
                        "JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = %s AND NOT t.tgisinternal",
                        (schema,)).fetchone()["n"] == 0
    assert sandbox.run(applied_fee.id, "SELECT count(*) FROM fee_register", target="lab").rows == [[3000]]
    # Identity continues after the copied ids.
    new_id = conn.execute(f"INSERT INTO {schema}.teachers (teacher, teacher_phone) VALUES ('x', 'y') RETURNING id"
                          ).fetchone()["id"]
    assert new_id == conn.execute("SELECT max(id) AS m FROM ws_%s.teachers" % applied_fee.id).fetchone()["m"] + 1
    conn.rollback()


def test_ensure_lab_is_idempotent_and_status(conn, applied_fee):
    assert status(conn, applied_fee.id).tables == []
    first = ensure_lab(conn, applied_fee.id)
    assert ensure_lab(conn, applied_fee.id) == first == status(conn, applied_fee.id)


def test_ensure_lab_needs_applied_design(conn, fee_ws):
    with pytest.raises(ApiError) as e:
        ensure_lab(conn, fee_ws.id)
    assert e.value.status == 409 and e.value.code == "not_applied"


def test_scale_multiplies_fact(conn, applied_fee):
    lab = scale(conn, applied_fee.id, 10)
    assert fact_rows(lab) == 30000 and lab.scale_factor == 10
    others = {t["name"]: t["row_count"] for t in lab.tables if t["name"] != "fee_register"}
    main = {t["name"]: t["row_count"] for t in catalog.describe(conn, applied_fee.id, "main").tables}
    assert others == {k: v for k, v in main.items() if k != "fee_register"}
    distinct = conn.execute(f"SELECT count(DISTINCT id) AS n FROM ws_{applied_fee.id}_lab.fee_register").fetchone()
    assert distinct["n"] == 30000
    # Scaling again multiplies the current size; the factor accumulates.
    lab = scale(conn, applied_fee.id, 2)
    assert fact_rows(lab) == 60000 and lab.scale_factor == 20
    assert fact_rows(reset_lab(conn, applied_fee.id)) == 3000
    assert status(conn, applied_fee.id).scale_factor == 1


def test_scale_limit(conn, applied_fee):
    with pytest.raises(ApiError) as e:
        scale(conn, applied_fee.id, 200)  # 3,000 x 200 = 600,000 > 500,000
    assert e.value.status == 422 and e.value.code == "scale_too_large"
    for bad in (1, 201):
        with pytest.raises(ApiError) as e:
            scale(conn, applied_fee.id, bad)
        assert e.value.status == 422 and e.value.code == "invalid_factor"
    assert fact_rows(status(conn, applied_fee.id)) == 3000


def test_try_index_records_experiment(conn, applied_fee_scaled):
    e = try_index(conn, applied_fee_scaled.id, QUERY, "fee_register", ["student_id"])
    assert e.after_plan.nodes[0].node_type in ("Index Scan", "Bitmap Heap Scan") and e.before_ms > 0 and e.after_ms > 0
    assert e.before_plan.nodes[0].node_type == "Seq Scan"
    assert e.index_name == "ix_fee_register_student_id"
    assert e.speedup == pytest.approx(e.before_ms / e.after_ms, rel=1e-3)
    lab = status(conn, applied_fee_scaled.id)
    fee = next(t for t in lab.tables if t["name"] == "fee_register")
    assert {"name": "ix_fee_register_student_id", "columns": ["student_id"]} in fee["indexes"]
    [row] = list_experiments(conn, applied_fee_scaled.id)
    assert row.id == e.id and row.status == "kept" and row.runs == 5 and row.columns == ["student_id"]
    assert row.ddl == f"CREATE INDEX ix_fee_register_student_id ON ws_{applied_fee_scaled.id}_lab.fee_register (student_id)"
    # The same index again is pointless.
    with pytest.raises(ApiError) as err:
        try_index(conn, applied_fee_scaled.id, QUERY, "fee_register", ["student_id"])
    assert err.value.code == "index_exists"

    dropped = drop_index(conn, applied_fee_scaled.id, e.id)
    assert dropped.status == "dropped"
    fee = next(t for t in status(conn, applied_fee_scaled.id).tables if t["name"] == "fee_register")
    assert [i["name"] for i in fee["indexes"]] == ["fee_register_pkey"]
    with pytest.raises(ApiError) as err:
        drop_index(conn, applied_fee_scaled.id, e.id + 1000)
    assert err.value.status == 404


def test_reset_marks_kept_experiments_dropped(conn, applied_fee_scaled):
    try_index(conn, applied_fee_scaled.id, QUERY, "fee_register", ["student_id"], runs=1)
    reset_lab(conn, applied_fee_scaled.id)
    assert [r.status for r in list_experiments(conn, applied_fee_scaled.id)] == ["dropped"]


def test_try_index_validates_names(conn, applied_fee):
    for table, cols, code in (("nope", ["id"], "unknown_table"), ("fee_register", ["nope"], "unknown_column")):
        with pytest.raises(ApiError) as e:
            try_index(conn, applied_fee.id, QUERY, table, cols)
        assert e.value.status == 422 and e.value.code == code


# ---- routes ---------------------------------------------------------------------------------------

@pytest.fixture
def ws_id(client, applied_fee) -> int:
    assert client.post("/api/auth/login", json=FIXTURE_USER).status_code == 200
    return applied_fee.id


def _url(ws_id: int, path: str) -> str:
    return f"/api/workspaces/{ws_id}{path}"


def test_try_index_rejects_injection(client, ws_id):
    r = client.post(_url(ws_id, "/lab/try-index"),
                    json={"sql": QUERY, "table": "fee_register", "columns": ['x"; DROP TABLE y; --']})
    assert r.status_code == 422 and r.json()["error"]["code"] == "unknown_column"
    r = client.post(_url(ws_id, "/lab/try-index"),
                    json={"sql": QUERY, "table": 'fee_register"; DROP TABLE y; --', "columns": ["student_id"]})
    assert r.status_code == 422 and r.json()["error"]["code"] == "unknown_table"


def test_lab_routes(client, ws_id):
    assert client.get(_url(ws_id, "/lab")).json() == {"tables": [], "scale_factor": 1}
    r = client.post(_url(ws_id, "/lab"))
    assert r.status_code == 200 and len(r.json()["tables"]) == 4
    r = client.post(_url(ws_id, "/lab/scale"), json={"factor": 10})
    assert r.status_code == 200 and r.json()["scale_factor"] == 10
    assert client.post(_url(ws_id, "/lab/scale"), json={"factor": 500}).status_code == 422
    r = client.post(_url(ws_id, "/explain"), json={"sql": QUERY + ";", "target": "lab"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["plan"]["nodes"][0]["node_type"] == "Seq Scan"
    assert [(s["table"], s["columns"]) for s in body["suggestions"]] == [("fee_register", ["student_id"])]
    [h] = client.get(_url(ws_id, "/history")).json()
    assert h["id"] == body["run_id"] and h["source"] == "perf" and h["target"] == "lab" and h["status"] == "ok"
    r = client.post(_url(ws_id, "/lab/try-index"), json={"sql": QUERY, "table": "fee_register",
                                                          "columns": ["student_id"]})
    assert r.status_code == 200, r.text
    exp = r.json()
    assert exp["after_plan"]["nodes"][0]["node_type"] in ("Index Scan", "Bitmap Heap Scan")
    [listed] = client.get(_url(ws_id, "/lab/experiments")).json()
    assert listed["id"] == exp["id"] and listed["status"] == "kept"
    r = client.delete(_url(ws_id, f"/lab/experiments/{exp['id']}"))
    assert r.status_code == 200 and r.json()["status"] == "dropped"
    r = client.post(_url(ws_id, "/lab/reset"))
    assert r.status_code == 200 and r.json()["scale_factor"] == 1


def test_explain_route_records_errors(client, ws_id):
    r = client.post(_url(ws_id, "/explain"), json={"sql": "SELECT nope FROM fee_register", "target": "main"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "db_error"
    assert r.json()["error"]["detail"]["position"] == 8
    r = client.post(_url(ws_id, "/explain"), json={"sql": "DELETE FROM fee_register", "target": "main"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "not_a_select"
    assert [h["status"] for h in client.get(_url(ws_id, "/history")).json()] == ["error", "error"]


def test_lab_routes_are_owner_only(client, second_client, ws_id, other_applied_ws):
    assert second_client.get(_url(ws_id, "/lab")).status_code == 401
    other_user = {"email": "fixture2@example.com", "password": "fixture-password"}
    assert second_client.post("/api/auth/login", json=other_user).status_code == 200
    reqs = [("get", "/lab", {}), ("post", "/lab", {}), ("post", "/lab/reset", {}),
            ("post", "/lab/scale", {"json": {"factor": 2}}), ("get", "/lab/experiments", {}),
            ("post", "/explain", {"json": {"sql": QUERY, "target": "lab"}}),
            ("post", "/lab/try-index", {"json": {"sql": QUERY, "table": "fee_register", "columns": ["student_id"]}}),
            ("delete", "/lab/experiments/1", {})]
    for method, path, kw in reqs:
        assert getattr(second_client, method)(_url(ws_id, path), **kw).status_code == 404
    # The lab of one workspace is out of reach of another workspace's queries.
    client.post(_url(ws_id, "/lab"))
    r = second_client.post(_url(other_applied_ws.id, "/explain"),
                           json={"sql": f"SELECT * FROM ws_{ws_id}_lab.fee_register", "target": "lab"})
    assert r.status_code == 400 and r.json()["error"]["detail"]["sqlstate"] == "42501"
