import pytest

from qlens.errors import ApiError
from qlens.stepthrough.stages import build_stages, run_stages

FIXTURE_USER = {"email": "fixture1@example.com", "password": "fixture-password"}  # owner of applied_fee

Q = """SELECT b.batch, count(*) AS unpaid FROM fee_register f JOIN students s ON s.id = f.student_id
       JOIN batches b ON b.id = s.batch_id WHERE f.fee_paid = 0 GROUP BY b.batch HAVING count(*) > 5 ORDER BY unpaid DESC LIMIT 3"""


def _kinds(sql: str) -> list[str]:
    return [s.kind for s in build_stages(sql)]


def _by_kind(sql: str) -> dict[str, str]:
    return {s.kind: s.sql for s in build_stages(sql)}


# ---- building stages (no database) ----------------------------------------------------------------

def test_stage_kinds():
    assert _kinds(Q) == ["from", "where", "group_by", "having", "select", "order_limit"]


def test_no_where_stage():
    assert "where" not in _kinds("SELECT * FROM students ORDER BY 1")
    assert _kinds("SELECT * FROM students ORDER BY 1") == ["from", "select", "order_limit"]


def test_distinct_stage_and_no_order_stage():
    assert _kinds("SELECT DISTINCT batch_id FROM students") == ["from", "select", "distinct"]


def test_stage_sql_is_cumulative():
    s = _by_kind(Q)
    assert s["from"].startswith("SELECT * FROM fee_register AS f INNER JOIN students AS s")
    assert "WHERE" not in s["from"]
    assert s["where"] == s["from"] + " WHERE f.fee_paid = 0"
    assert s["group_by"].startswith("SELECT b.batch, count(*) AS rows_in_group FROM fee_register")
    assert s["group_by"].endswith("WHERE f.fee_paid = 0 GROUP BY b.batch")
    assert s["having"] == s["group_by"] + " HAVING count(*) > 5"
    assert "ORDER BY" not in s["select"] and "LIMIT" not in s["select"]
    assert s["select"].startswith("SELECT b.batch, count(*) AS unpaid FROM")
    assert s["order_limit"].endswith("ORDER BY unpaid DESC LIMIT 3")


def test_group_by_ordinal_and_alias_resolve_to_the_select_list():
    s = _by_kind("SELECT batch_id AS b, count(*) FROM students GROUP BY 1")
    # GROUP BY 1 would group by the constant 1 in a select list of its own; it must become the expression.
    assert s["group_by"] == "SELECT batch_id AS b, count(*) AS rows_in_group FROM students GROUP BY batch_id"
    s = _by_kind("SELECT upper(name) AS who, count(*) FROM students GROUP BY who")
    assert s["group_by"] == "SELECT upper(name) AS who, count(*) AS rows_in_group FROM students GROUP BY who"


def test_titles_use_relational_algebra():
    titles = {s.kind: s.title for s in build_stages(Q)}
    assert titles["from"].startswith("Join") and titles["where"].startswith("Selection")
    assert titles["select"].startswith("Projection") and titles["group_by"].startswith("Grouping")
    assert build_stages("SELECT * FROM students")[0].title.startswith("Relation")
    assert build_stages("SELECT * FROM students, batches")[0].title.startswith("Cartesian product")


@pytest.mark.parametrize("sql", [
    "SELECT 1 UNION SELECT 2",
    "WITH x AS (SELECT 1) SELECT * FROM x",
    "SELECT rank() OVER (ORDER BY id) FROM students",
    "SELECT 1",
    "SELECT batch_id, count(*) FROM students GROUP BY ROLLUP (batch_id)",
])
def test_unsupported(sql):
    with pytest.raises(ApiError) as e:
        build_stages(sql)
    assert e.value.status == 422 and e.value.code == "stepthrough_unsupported" and e.value.message


def test_window_function_inside_a_subquery_is_fine():
    assert _kinds("SELECT * FROM (SELECT rank() OVER (ORDER BY id) AS r FROM students) t WHERE r < 5") == [
        "from", "where", "select"]


def test_validation_errors_pass_through():
    with pytest.raises(ApiError) as e:
        build_stages("DELETE FROM students")
    assert e.value.code == "not_a_select"


def test_deep_query_is_refused_not_crashed():
    # ~2,600 tokens: accepted by the validator's 4,000-token cap, but far too deep to show as stages.
    sql = "SELECT " + "+".join(["1"] * 1300) + " FROM students"
    with pytest.raises(ApiError) as e:
        build_stages(sql)
    assert e.value.code == "stepthrough_unsupported"


# ---- running stages (real Postgres, workspace role) -----------------------------------------------

def test_run_stages_counts(applied_fee):
    st = run_stages(applied_fee.id, Q)
    assert st[0].row_count == 3000 and st[1].row_count < 3000 and st[-1].row_count <= 3
    assert all(len(s.rows) <= 50 for s in st)
    assert st[0].caption == "Combine fee_register, students, batches: 3,000 rows"
    removed = 3000 - st[1].row_count
    assert st[1].caption == f"Keep rows where f.fee_paid = 0: {st[1].row_count:,} rows ({removed:,} removed)"
    assert st[2].caption.startswith("Group into ") and st[2].caption.endswith(" by b.batch")
    assert [c["name"] for c in st[2].columns] == ["batch", "rows_in_group"]
    assert st[-1].caption.startswith("Sort and limit: ")
    assert [c["name"] for c in st[-1].columns] == ["batch", "unpaid"]


def test_stepthrough_route_records_one_run(client, applied_fee):
    assert client.post("/api/auth/login", json=FIXTURE_USER).status_code == 200
    r = client.post(f"/api/workspaces/{applied_fee.id}/stepthrough", json={"sql": Q + ";"})
    assert r.status_code == 200, r.text
    stages = r.json()
    assert [s["kind"] for s in stages] == ["from", "where", "group_by", "having", "select", "order_limit"]
    assert {"kind", "title", "caption", "sql", "row_count", "columns", "rows"} <= stages[0].keys()
    [h] = client.get(f"/api/workspaces/{applied_fee.id}/history").json()
    assert h["source"] == "stepthrough" and h["status"] == "ok" and h["sql_text"] == Q
    assert h["row_count"] == stages[-1]["row_count"]


def test_stepthrough_route_unsupported_is_recorded(client, applied_fee):
    assert client.post("/api/auth/login", json=FIXTURE_USER).status_code == 200
    r = client.post(f"/api/workspaces/{applied_fee.id}/stepthrough", json={"sql": "SELECT 1"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "stepthrough_unsupported"
    [h] = client.get(f"/api/workspaces/{applied_fee.id}/history").json()
    assert h["source"] == "stepthrough" and h["status"] == "error"


def test_stepthrough_route_db_error(client, applied_fee):
    assert client.post("/api/auth/login", json=FIXTURE_USER).status_code == 200
    r = client.post(f"/api/workspaces/{applied_fee.id}/stepthrough", json={"sql": "SELECT nope FROM students"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "db_error"
