import time

import pytest

from qlens.analysis.discover import analyze, lhs_eligible
from qlens.ingest.stage import ColumnOut, import_dataset

CREDS = {"email": "ana@x.com", "password": "correct horse", "display_name": "Ana"}
FEE_COLUMNS = ["student_name", "student_phone", "batch", "teacher", "teacher_phone", "month", "fee_paid",
               "payment_mode"]


def col(name, type_="text", distinct=5):
    return ColumnOut(id=1, ordinal=1, name=name, label=name, inferred_type=type_, null_count=0,
                     distinct_count=distinct, sample_values=[])


def dataset_id_of(conn, ws_id):
    return conn.execute("SELECT id FROM qlens.datasets WHERE workspace_id = %s", (ws_id,)).fetchone()["id"]


def test_check_fd_counts(conn, staged_tiny):
    schema, table = staged_tiny
    r = conn.execute("SELECT * FROM qlens.check_fd(%s, %s, %s, %s)", (schema, table, ["a"], "b")).fetchone()
    assert r == {"row_count": 4, "lhs_values": 2, "repeated_groups": 1, "violating_rows": 1}
    r = conn.execute("SELECT * FROM qlens.check_fd(%s, %s, %s, %s)", (schema, table, ["b"], "a")).fetchone()
    assert r["violating_rows"] == 0 and r["lhs_values"] == 3 and r["repeated_groups"] == 1


def test_check_fd_treats_null_as_a_value(conn, staged_tiny):
    schema, table = staged_tiny
    conn.execute("INSERT INTO ws_tiny_src._staging VALUES (5, NULL, 'p'), (6, NULL, 'q')")
    r = conn.execute("SELECT * FROM qlens.check_fd(%s, %s, %s, %s)", (schema, table, ["a"], "b")).fetchone()
    assert r["lhs_values"] == 3 and r["violating_rows"] == 2   # a=1 loses one row, the NULL group loses one


def test_is_unique(conn, staged_tiny):
    schema, table = staged_tiny
    q = "SELECT qlens.is_unique(%s, %s, %s) AS u"
    assert conn.execute(q, (schema, table, ["_row_id"])).fetchone()["u"] is True
    assert conn.execute(q, (schema, table, ["a"])).fetchone()["u"] is False
    assert conn.execute(q, (schema, table, ["a", "b"])).fetchone()["u"] is False
    assert conn.execute(q, (schema, table, ["_row_id", "a"])).fetchone()["u"] is True


def test_lhs_eligible():
    assert lhs_eligible(col("teacher"))
    assert not lhs_eligible(col("paid", "boolean"))
    assert not lhs_eligible(col("fee_paid", "integer"))
    assert not lhs_eligible(col("price", "numeric"))
    assert lhs_eligible(col("emp_id", "integer")) and lhs_eligible(col("pin_code", "integer"))
    assert lhs_eligible(col("id", "integer")) and lhs_eligible(col("roll_no", "integer"))
    assert not lhs_eligible(col("grid", "integer"))          # ends in "id" but is not an id column
    assert not lhs_eligible(col("teacher", distinct=1))
    assert not lhs_eligible(col("teacher", distinct=0))


def test_fee_register_keys_and_fds(conn, fee_ws):
    a = analyze(conn, fee_ws.dataset_id)
    assert a.row_count == 3000
    assert ["student_name", "month"] in a.keys and ["student_phone", "month"] in a.keys
    exact = {(tuple(f.lhs), f.rhs) for f in a.fds if f.is_exact}
    assert (("student_phone",), "batch") in exact and (("batch",), "teacher") in exact
    approx = [f for f in a.fds if not f.is_exact and f.lhs == ["teacher"] and f.rhs == "teacher_phone"]
    assert approx and approx[0].violating_rows == 5
    assert not any("fee_paid" in f.lhs for f in a.fds)              # measures never determine
    variants = [f for f in a.fds if f.lhs == ["student_phone"] and f.rhs == "student_name"]
    assert variants and variants[0].violating_rows == 8 and not variants[0].is_exact
    status = conn.execute("SELECT status FROM qlens.datasets WHERE id = %s", (fee_ws.dataset_id,)).fetchone()
    assert status["status"] == "analyzed"


def test_no_redundant_fds(conn, fee_ws):
    a = analyze(conn, fee_ws.dataset_id)
    exact_single = {(f.lhs[0], f.rhs) for f in a.fds if f.is_exact and len(f.lhs) == 1}
    keys = [set(k) for k in a.keys]
    for f in a.fds:
        assert f.rhs not in f.lhs
        assert not any(k <= set(f.lhs) for k in keys)
        if len(f.lhs) == 2:
            assert not any((c, f.rhs) in exact_single for c in f.lhs)
        assert f.lhs == sorted(f.lhs, key=FEE_COLUMNS.index)         # column-ordinal order


def test_constant_and_empty_columns(conn, workspace):
    import_dataset(conn, workspace, "t.csv",
                   b"Name,Country,Blank,City\nA,India,,Pune\nB,India,,Pune\nA,India,,Pune\nC,India,,Goa\n", "upload")
    a = analyze(conn, dataset_id_of(conn, workspace))
    assert not any(f.rhs in ("country", "blank") for f in a.fds)
    assert not any(c in f.lhs for f in a.fds for c in ("country", "blank"))


def test_null_in_column_blocks_key(conn, workspace):
    import_dataset(conn, workspace, "t.csv", b"Code,Name\nA,x\n,y\nC,z\n", "upload")
    a = analyze(conn, dataset_id_of(conn, workspace))
    assert ["code"] not in a.keys and ["name"] in a.keys


def test_analysis_sentence(conn, fee_ws):
    a = analyze(conn, fee_ws.dataset_id)
    by = {(tuple(f.lhs), f.rhs): f for f in a.fds}
    assert by[(("batch",), "teacher")].sentence == "Each Batch has exactly one Teacher"
    assert by[(("teacher",), "teacher_phone")].sentence == \
        "Each Teacher has exactly one Teacher Phone except in 5 rows"
    assert all(" + " in f.sentence for f in a.fds if len(f.lhs) == 2)


def test_fee_register_is_fast(conn, fee_ws):
    t = time.perf_counter()
    analyze(conn, fee_ws.dataset_id)
    elapsed = time.perf_counter() - t
    print(f"analyze(fee_register) took {elapsed:.2f}s")
    assert elapsed < 5


def core_fds(a):
    """The non-derived FDs: what the analysis page shows by default."""
    return {(tuple(f.lhs), f.rhs, f.is_exact, f.violating_rows) for f in a.fds if not f.is_derived}


# Dependencies whose LHS contains a candidate key are not listed (a key determines everything), so
# e.g. (student_name, month) -> fee_paid does not appear; the synthesis gets the keys separately.
def test_fee_register_core_fds(conn, fee_ws):
    a = analyze(conn, fee_ws.dataset_id)
    assert core_fds(a) == {
        (("student_name",), "student_phone", True, 0),
        (("student_phone",), "student_name", False, 8),
        (("student_phone",), "batch", True, 0),
        (("batch",), "teacher", True, 0),
        (("teacher",), "teacher_phone", False, 5),
        (("teacher_phone",), "teacher", True, 0),
    }
    derived = {(tuple(f.lhs), f.rhs) for f in a.fds if f.is_derived}
    assert derived == {(("student_name",), "batch"), (("student_name",), "teacher"),
                       (("student_phone",), "teacher")}
    assert not any(not f.is_exact and f.is_derived for f in a.fds)
    # fee_paid and payment_mode are determined by the keys only
    assert not any(f.rhs in ("fee_paid", "payment_mode") for f in a.fds)


def test_kirana_core_fds(conn, kirana_ws):
    a = analyze(conn, kirana_ws.dataset_id)
    assert a.keys == [["bill_no", "item"]]
    assert core_fds(a) == {
        (("bill_no",), "date", True, 0),
        (("bill_no",), "customer_phone", True, 0),
        (("customer",), "customer_phone", True, 0),
        (("customer_phone",), "customer", False, 3),      # 'Mohan lal'
        (("item",), "category", True, 0),
        (("item",), "unit_price", False, 3),               # Toor Dal's old price
    }


def test_hostel_core_fds(conn, hostel_ws):
    a = analyze(conn, hostel_ws.dataset_id)
    assert core_fds(a) == {
        (("room",), "hostel_block", True, 0),
        (("student",), "room", True, 0),
        (("hostel_block",), "warden", False, 2),           # 'Mrs Rao'
        (("warden",), "hostel_block", True, 0),
        (("menu_item",), "meal", True, 0),
        (("date", "meal"), "menu_item", True, 0),
    }


# ---- routes ---------------------------------------------------------------------------------------

@pytest.fixture
def api_ws(client):
    client.post("/api/auth/signup", json=CREDS)
    ws_id = client.post("/api/workspaces", json={"name": "Analysis"}).json()["id"]
    client.post(f"/api/workspaces/{ws_id}/dataset/sample", json={"name": "fee_register"})
    return ws_id


def test_routes_flow(client, api_ws):
    r = client.get(f"/api/workspaces/{api_ws}/analysis")
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_analyzed"
    posted = client.post(f"/api/workspaces/{api_ws}/analyze")
    assert posted.status_code == 200
    body = posted.json()
    assert set(body) == {"dataset_id", "row_count", "keys", "fds", "duplicates", "inconsistencies"}
    assert body["duplicates"] == [] and body["inconsistencies"] == []
    assert set(body["fds"][0]) == {"id", "lhs", "rhs", "is_exact", "violating_rows", "violation_ratio",
                                   "accepted", "is_derived", "sentence"}
    assert client.get(f"/api/workspaces/{api_ws}/analysis").json() == body


def test_reanalysis_preserves_rejections(client, api_ws):
    fds = client.post(f"/api/workspaces/{api_ws}/analyze").json()["fds"]
    target = next(f for f in fds if f["lhs"] == ["batch"] and f["rhs"] == "teacher")
    r = client.patch(f"/api/workspaces/{api_ws}/fds/{target['id']}", json={"accepted": False})
    assert r.status_code == 200 and r.json()["accepted"] is False and r.json()["id"] == target["id"]
    again = client.post(f"/api/workspaces/{api_ws}/analyze").json()["fds"]
    got = {(tuple(f["lhs"]), f["rhs"]): f["accepted"] for f in again}
    assert got[(("batch",), "teacher")] is False
    assert got[(("student_phone",), "batch")] is True


def test_analysis_routes_guard(client, second_client, api_ws):
    fd_id = client.post(f"/api/workspaces/{api_ws}/analyze").json()["fds"][0]["id"]
    assert second_client.post(f"/api/workspaces/{api_ws}/analyze").status_code == 401
    second_client.post("/api/auth/signup", json={"email": "o@x.com", "password": "another pass",
                                                  "display_name": "O"})
    assert second_client.get(f"/api/workspaces/{api_ws}/analysis").status_code == 404
    # a dependency id from another workspace is invisible
    mine = second_client.post("/api/workspaces", json={"name": "Mine"}).json()["id"]
    second_client.post(f"/api/workspaces/{mine}/dataset/sample", json={"name": "fee_register"})
    r = second_client.patch(f"/api/workspaces/{mine}/fds/{fd_id}", json={"accepted": False})
    assert r.status_code == 404 and r.json()["error"]["code"] == "fd_not_found"


def test_analyze_without_dataset(client):
    client.post("/api/auth/signup", json=CREDS)
    ws_id = client.post("/api/workspaces", json={"name": "Empty"}).json()["id"]
    r = client.post(f"/api/workspaces/{ws_id}/analyze")
    assert r.status_code == 404 and r.json()["error"]["code"] == "no_dataset"


def test_derived_follows_acceptance(client, api_ws):
    def derived(fds):
        return {(tuple(f["lhs"]), f["rhs"]): f["is_derived"] for f in fds}

    fds = client.post(f"/api/workspaces/{api_ws}/analyze").json()["fds"]
    assert derived(fds)[(("student_phone",), "teacher")] is True
    assert derived(fds)[(("batch",), "teacher")] is False
    assert derived(fds)[(("teacher",), "teacher_phone")] is False          # approximate: never derived
    batch_teacher = next(f["id"] for f in fds if f["lhs"] == ["batch"] and f["rhs"] == "teacher")
    client.patch(f"/api/workspaces/{api_ws}/fds/{batch_teacher}", json={"accepted": False})
    after = client.get(f"/api/workspaces/{api_ws}/analysis").json()["fds"]
    # without batch -> teacher, student_phone -> teacher is no longer implied by the others
    assert derived(after)[(("student_phone",), "teacher")] is False
    assert derived(after)[(("batch",), "teacher")] is False         # rejected FDs are never "derived"
