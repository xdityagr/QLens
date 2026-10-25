import pytest

from qlens import db
from qlens.errors import ApiError
from qlens.perf.explain import explain, parse_plan


def test_explain_nodes(conn, applied_fee):
    p = explain(conn, applied_fee.id, "SELECT * FROM fee_register WHERE student_id = 5", "lab")
    assert p.nodes[0].node_type == "Seq Scan" and p.nodes[0].relation == "fee_register" and p.nodes[0].actual_rows == 10
    n = p.nodes[0]
    assert n.filter == "(student_id = 5)" and n.parent_id is None and n.depth == 0 and n.loops == 1
    assert n.est_rows > 0 and n.cost > 0 and n.total_ms >= 0 and n.self_ms == n.total_ms
    assert n.pct_of_total == 100.0 and p.execution_ms > 0 and p.planning_ms >= 0
    assert p.plan["Plan"]["Node Type"] == "Seq Scan"
    # Explaining the lab built it; the snapshot is kept.
    assert db.ws_schema(applied_fee.id, "lab") in [r["nspname"] for r in conn.execute("SELECT nspname FROM pg_namespace")]
    snap = conn.execute("SELECT * FROM qlens.explain_snapshots WHERE id = %s", (p.snapshot_id,)).fetchone()
    assert snap["workspace_id"] == applied_fee.id and snap["target"] == "lab" and snap["query_run_id"] is None
    assert snap["plan"] == p.plan and float(snap["execution_ms"]) == pytest.approx(p.execution_ms, abs=1e-3)


def test_explain_join_tree(conn, applied_fee):
    p = explain(conn, applied_fee.id, "SELECT s.student_name, count(*) FROM fee_register f "
                                      "JOIN students s ON s.id = f.student_id GROUP BY s.student_name", "main")
    ids = [n.id for n in p.nodes]
    assert ids == list(range(len(p.nodes)))
    by_id = {n.id: n for n in p.nodes}
    for n in p.nodes[1:]:
        parent = by_id[n.parent_id]
        assert parent.id < n.id and n.depth == parent.depth + 1
        assert 0 <= n.self_ms <= n.total_ms + 1e-9
    assert sum(n.pct_of_total for n in p.nodes) == pytest.approx(100, abs=0.5)
    assert {n.relation for n in p.nodes if n.relation} == {"fee_register", "students"}
    # The main target never builds the lab.
    assert db.ws_schema(applied_fee.id, "lab") not in [r["nspname"] for r in
                                                       conn.execute("SELECT nspname FROM pg_namespace")]


def test_explain_rejects_non_select(conn, applied_fee):
    with pytest.raises(ApiError) as e:
        explain(conn, applied_fee.id, "DELETE FROM fee_register", "main")
    assert e.value.code == "not_a_select"


def _node(node_type, time, loops, plans=(), **extra):
    return {"Node Type": node_type, "Plan Rows": 1, "Total Cost": 1.0, "Actual Total Time": time,
            "Actual Rows": 1.0, "Actual Loops": loops, "Plans": list(plans), **extra}


def test_parse_plan_times():
    # Inner index scan runs 4 times at 0.5 ms each: 2 ms in all. Its parent's own time is what remains.
    doc = {"Plan": _node("Nested Loop", 3.0, 1, [
        _node("Seq Scan", 0.5, 1, **{"Relation Name": "a", "Alias": "a", "Filter": "(x = 1)"}),
        _node("Index Scan", 0.5, 4, **{"Relation Name": "b", "Alias": "bb", "Index Name": "b_pkey",
                                       "Index Cond": "(id = a.b_id)"}),
    ], **{"Join Type": "Inner"}), "Planning Time": 0.25, "Execution Time": 3.1}
    p = parse_plan(doc)
    assert (p.planning_ms, p.execution_ms) == (0.25, 3.1)
    loop, scan, idx = p.nodes
    assert (loop.join_type, loop.parent_id, scan.parent_id, idx.parent_id) == ("Inner", None, 0, 0)
    assert idx.total_ms == 2.0 and idx.self_ms == 2.0 and idx.alias == "bb" and idx.index_name == "b_pkey"
    assert idx.index_cond == "(id = a.b_id)" and scan.filter == "(x = 1)"
    assert loop.total_ms == 3.0 and loop.self_ms == pytest.approx(0.5)
    assert [round(n.pct_of_total) for n in p.nodes] == [17, 17, 67]
    # Parallel workers can make children add up to more than the parent: self time never goes negative.
    p = parse_plan({"Plan": _node("Gather", 1.0, 1, [_node("Parallel Seq Scan", 0.9, 3)]),
                    "Planning Time": 0.1, "Execution Time": 1.0})
    assert p.nodes[0].self_ms == 0
