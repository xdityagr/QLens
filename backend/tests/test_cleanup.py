import json

import pytest

from qlens import db
from qlens.analysis import cleanup
from qlens.analysis.cleanup import accept_all, dismiss_group, find_duplicates, fix_fd, inconsistencies, merge_group
from qlens.analysis.discover import analyze, get_analysis
from qlens.errors import ApiError
from qlens.ingest.stage import import_dataset

CREDS = {"email": "ana@x.com", "password": "correct horse", "display_name": "Ana"}


def src(conn, ws_id, table="_staging"):
    return f"{db.ws_schema(ws_id, 'src')}.{table}"


def raw_rows(conn, ws_id):
    return conn.execute(f"SELECT * FROM {src(conn, ws_id, '_raw')} ORDER BY _row_id").fetchall()


def group_of(a, canonical, column=None):
    return next(d for d in a.duplicates if d.canonical_value == canonical and (column is None or d.column == column))


def non_derived_exact(a):
    return {(tuple(f.lhs), f.rhs) for f in a.fds if f.is_exact and not f.is_derived}


def test_variants_grouped_same_normalized(conn, fee_ws):
    a = analyze(conn, fee_ws.dataset_id)
    g = next(d for d in a.duplicates if d.canonical_value == "Riya Sharma")
    assert g.confidence == "same_normalized" and {v.value for v in g.values} >= {"riya sharma", "Riya  Sharma"}
    assert not any(d.confidence == "same_normalized" and "Priya Sharma" in {v.value for v in d.values}
                   for d in a.duplicates)
    assert g.column == "student_name" and g.status == "pending" and 0 < g.max_similarity <= 1
    # the canonical spelling is the most frequent one
    rows = {v.value: v.rows for v in g.values}
    assert rows["Riya Sharma"] == max(rows.values())
    for name in ("Aman Verma", "Neha Singh", "Karan Mehta"):
        assert group_of(a, name, "student_name").confidence == "same_normalized"


def test_phone_numbers_are_not_near_duplicates(conn, fee_ws):
    a = analyze(conn, fee_ws.dataset_id)
    assert {d.column for d in a.duplicates} == {"student_name"}


def test_merge_updates_staging_and_logs(conn, fee_ws):
    before_raw = raw_rows(conn, fee_ws.id)
    a = analyze(conn, fee_ws.dataset_id)
    g = group_of(a, "Riya Sharma")
    distinct_before = conn.execute("SELECT distinct_count FROM qlens.dataset_columns WHERE dataset_id = %s "
                                   "AND name = 'student_name'", (fee_ws.dataset_id,)).fetchone()["distinct_count"]

    changed = merge_group(conn, fee_ws.dataset_id, g.id, None)

    assert changed == 2
    left = conn.execute(f"SELECT count(*) AS n FROM {src(conn, fee_ws.id)} "
                        "WHERE lower(btrim(student_name)) = 'riya sharma' AND student_name <> 'Riya Sharma'"
                        ).fetchone()["n"]
    assert left == 0
    fixes = conn.execute("SELECT kind, from_value, to_value, rows_affected FROM qlens.dataset_fixes "
                         "WHERE dataset_id = %s", (fee_ws.dataset_id,)).fetchall()
    assert sum(f["rows_affected"] for f in fixes) == 2
    assert {f["kind"] for f in fixes} == {"merge"} and {f["to_value"] for f in fixes} == {"Riya Sharma"}
    assert {f["from_value"] for f in fixes} == {"riya sharma", "Riya  Sharma"}
    assert conn.execute("SELECT status FROM qlens.duplicate_groups WHERE id = %s", (g.id,)).fetchone()[
        "status"] == "merged"
    # the profile that discovery prunes by follows the edit
    col = conn.execute("SELECT distinct_count, sample_values FROM qlens.dataset_columns WHERE dataset_id = %s "
                       "AND name = 'student_name'", (fee_ws.dataset_id,)).fetchone()
    assert col["distinct_count"] == distinct_before - 2 and "riya sharma" not in col["sample_values"]
    assert raw_rows(conn, fee_ws.id) == before_raw                 # _raw is never touched


def test_merge_with_chosen_canonical(conn, fee_ws):
    g = group_of(analyze(conn, fee_ws.dataset_id), "Neha Singh")
    other = next(v.value for v in g.values if v.value != "Neha Singh")
    assert merge_group(conn, fee_ws.dataset_id, g.id, other) >= 1
    names = {r["student_name"] for r in conn.execute(f"SELECT student_name FROM {src(conn, fee_ws.id)}")}
    assert "Neha Singh" not in names and other in names
    assert conn.execute("SELECT canonical_value FROM qlens.duplicate_groups WHERE id = %s",
                        (g.id,)).fetchone()["canonical_value"] == other


def test_merge_rejects_foreign_canonical_and_repeat(conn, fee_ws):
    g = group_of(analyze(conn, fee_ws.dataset_id), "Riya Sharma")
    with pytest.raises(ApiError) as e:
        merge_group(conn, fee_ws.dataset_id, g.id, "Somebody Else")
    assert e.value.code == "bad_canonical"
    merge_group(conn, fee_ws.dataset_id, g.id, None)
    with pytest.raises(ApiError) as e:
        merge_group(conn, fee_ws.dataset_id, g.id, None)
    assert e.value.code == "group_not_pending"
    with pytest.raises(ApiError) as e:
        merge_group(conn, fee_ws.dataset_id, 999999, None)
    assert e.value.code == "group_not_found"


def test_dismissed_and_merged_groups_survive_reanalysis(conn, fee_ws):
    a = analyze(conn, fee_ws.dataset_id)
    merged, dismissed = group_of(a, "Riya Sharma"), group_of(a, "Aman Verma")
    merge_group(conn, fee_ws.dataset_id, merged.id, None)
    dismiss_group(conn, fee_ws.dataset_id, dismissed.id)
    again = analyze(conn, fee_ws.dataset_id)
    status = {d.canonical_value: d.status for d in again.duplicates}
    assert status["Riya Sharma"] == "merged" and status["Aman Verma"] == "dismissed"
    assert status["Neha Singh"] == "pending" and status["Karan Mehta"] == "pending"
    assert {d.id for d in again.duplicates if d.status != "pending"} == {merged.id, dismissed.id}
    # Re-running detection replaces the pending groups instead of piling up copies. The merged spelling
    # is now a single value, so it can show up as a "similar" candidate that it was not before.
    new = [d for d in again.duplicates if d.status == "pending" and d.canonical_value not in
           {g.canonical_value for g in a.duplicates}]
    assert len(new) == 1 and new[0].confidence == "similar"
    assert {"Priya Sharma", "Riya Sharma"} <= {v.value for v in new[0].values}
    assert len(again.duplicates) == len(a.duplicates) + 1


def test_similar_but_not_identical_values(conn, workspace):
    import_dataset(conn, workspace, "t.csv",
                   b"Shop,Item\nSharma Traders,a\nSharma Traders,b\nSharma Trader,c\nGupta Stores,d\n"
                   b"Gupta Stores,e\nVerma Kirana,f\n", "upload")
    ds = conn.execute("SELECT id FROM qlens.datasets WHERE workspace_id = %s", (workspace,)).fetchone()["id"]
    a = analyze(conn, ds)
    g = next(d for d in a.duplicates if d.column == "shop")
    assert g.confidence == "similar" and g.canonical_value == "Sharma Traders"
    assert {v.value for v in g.values} == {"Sharma Traders", "Sharma Trader"}
    assert 0.6 <= g.max_similarity < 1
    assert len(a.duplicates) == 1


def test_find_duplicates_skips_columns_outside_limits(conn, workspace):
    import_dataset(conn, workspace, "t.csv", b"Code,Note\nA,x\nA,y\nA,z\n", "upload")
    ds = conn.execute("SELECT id FROM qlens.datasets WHERE workspace_id = %s", (workspace,)).fetchone()["id"]
    find_duplicates(conn, ds)                       # one distinct value in Code, unique values in Note
    assert conn.execute("SELECT count(*) AS n FROM qlens.duplicate_groups").fetchone()["n"] == 0


def test_inconsistencies_for_approximate_fd(conn, fee_ws):
    analyze(conn, fee_ws.dataset_id)
    incs = inconsistencies(conn, fee_ws.dataset_id)
    inc = next(i for i in incs if i.lhs == ["teacher"] and i.rhs == "teacher_phone")
    assert inc.sentence == "Each Teacher has exactly one Teacher Phone except in 5 rows"
    assert len(inc.conflicts) == 1
    c = inc.conflicts[0]
    assert c.lhs_values == ["Mr. Gupta"] and len(c.variants) == 2
    assert sum(v.rows for v in c.variants) > 5 and min(v.rows for v in c.variants) == 5
    assert c.suggested == max(c.variants, key=lambda v: v.rows).value
    # exact dependencies are not inconsistencies
    assert all(not (i.lhs == ["batch"] and i.rhs == "teacher") for i in incs)


def test_inconsistencies_limit_per_fd(conn, fee_ws):
    analyze(conn, fee_ws.dataset_id)
    inc = next(i for i in inconsistencies(conn, fee_ws.dataset_id, limit_per_fd=2)
               if i.lhs == ["student_phone"] and i.rhs == "student_name")
    assert len(inc.conflicts) == 2


def test_rejected_fd_is_not_listed_or_fixable(conn, fee_ws):
    a = analyze(conn, fee_ws.dataset_id)
    fd = next(f for f in a.fds if f.lhs == ["teacher"] and f.rhs == "teacher_phone")
    conn.execute("UPDATE qlens.functional_dependencies SET accepted = false WHERE id = %s", (fd.id,))
    assert not any(i.fd_id == fd.id for i in inconsistencies(conn, fee_ws.dataset_id))
    with pytest.raises(ApiError) as e:
        fix_fd(conn, fee_ws.dataset_id, fd.id, None)
    assert e.value.code == "fd_not_accepted"


def test_fix_fd_makes_it_exact(conn, fee_ws):
    before_raw = raw_rows(conn, fee_ws.id)
    a = analyze(conn, fee_ws.dataset_id)
    fd = next(f for f in a.fds if f.lhs == ["teacher"] and f.rhs == "teacher_phone")
    assert not fd.is_exact
    assert fix_fd(conn, fee_ws.dataset_id, fd.id, None) == 5
    after = analyze(conn, fee_ws.dataset_id)
    now = next(f for f in after.fds if f.lhs == ["teacher"] and f.rhs == "teacher_phone")
    assert now.is_exact and now.violating_rows == 0
    fixes = conn.execute("SELECT kind, rows_affected FROM qlens.dataset_fixes WHERE dataset_id = %s",
                         (fee_ws.dataset_id,)).fetchall()
    assert [(f["kind"], f["rows_affected"]) for f in fixes] == [("fd_fix", 5)]
    assert raw_rows(conn, fee_ws.id) == before_raw


def test_fix_fd_override(conn, fee_ws):
    a = analyze(conn, fee_ws.dataset_id)
    fd = next(f for f in a.fds if f.lhs == ["teacher"] and f.rhs == "teacher_phone")
    inc = next(i for i in inconsistencies(conn, fee_ws.dataset_id) if i.fd_id == fd.id)
    c = inc.conflicts[0]
    minority = min(c.variants, key=lambda v: v.rows).value
    assert minority != c.suggested
    n = fix_fd(conn, fee_ws.dataset_id, fd.id, {json.dumps(c.lhs_values): minority})
    assert n > 5                                    # the majority rows were rewritten instead
    after = analyze(conn, fee_ws.dataset_id)
    assert next(f for f in after.fds if f.lhs == ["teacher"] and f.rhs == "teacher_phone").is_exact


def test_fix_fd_on_typed_columns(conn, kirana_ws):
    a = analyze(conn, kirana_ws.dataset_id)
    fd = next(f for f in a.fds if f.lhs == ["item"] and f.rhs == "unit_price")      # numeric RHS
    assert fix_fd(conn, kirana_ws.dataset_id, fd.id, None) == 3
    inc_after = analyze(conn, kirana_ws.dataset_id)
    assert next(f for f in inc_after.fds if f.lhs == ["item"] and f.rhs == "unit_price").is_exact


def test_kirana_variant(conn, kirana_ws):
    a = analyze(conn, kirana_ws.dataset_id)
    g = group_of(a, "Mohan Lal")
    assert g.confidence == "same_normalized" and {v.value for v in g.values} == {"Mohan Lal", "Mohan lal"}


def test_mess_warden_variant(conn, hostel_ws):
    a = analyze(conn, hostel_ws.dataset_id)
    g = next(d for d in a.duplicates if d.column == "warden")
    assert g.confidence == "same_normalized" and {v.value for v in g.values} == {"Mrs. Rao", "Mrs Rao"}
    merge_group(conn, hostel_ws.dataset_id, g.id, None)
    after = analyze(conn, hostel_ws.dataset_id)
    assert next(f for f in after.fds if f.lhs == ["hostel_block"] and f.rhs == "warden").is_exact


def test_accept_all_fee_register(conn, fee_ws):
    before_raw = raw_rows(conn, fee_ws.id)
    a = accept_all(conn, fee_ws.dataset_id)
    assert all(f.is_exact for f in a.fds if f.accepted) and ["student_name", "month"] in a.keys
    assert not any(not f.is_exact for f in a.fds)
    # student_name and student_phone now determine each other, so either one may carry "-> batch"; the
    # minimal cover keeps the first in column order (student_name), the other becomes derived.
    assert non_derived_exact(a) == {
        (("student_name",), "student_phone"), (("student_phone",), "student_name"),
        (("student_name",), "batch"), (("batch",), "teacher"),
        (("teacher",), "teacher_phone"), (("teacher_phone",), "teacher"),
    }
    assert {(tuple(f.lhs), f.rhs) for f in a.fds if f.is_derived} == {
        (("student_phone",), "batch"), (("student_name",), "teacher"), (("student_phone",), "teacher"),
        (("batch",), "teacher_phone"), (("student_name",), "teacher_phone"), (("student_phone",), "teacher_phone")}
    assert not [d for d in a.duplicates if d.status == "pending" and d.confidence == "same_normalized"]
    assert a.inconsistencies == []
    assert raw_rows(conn, fee_ws.id) == before_raw
    kinds = {r["kind"] for r in conn.execute("SELECT kind FROM qlens.dataset_fixes")}
    assert kinds == {"merge", "fd_fix"}


def test_accept_all_on_clean_data_changes_nothing(conn, workspace):
    import_dataset(conn, workspace, "t.csv", b"A,B\nx,1\ny,2\nx,1\ny,2\n", "upload")
    ds = conn.execute("SELECT id FROM qlens.datasets WHERE workspace_id = %s", (workspace,)).fetchone()["id"]
    a = accept_all(conn, ds)
    assert conn.execute("SELECT count(*) AS n FROM qlens.dataset_fixes").fetchone()["n"] == 0
    assert a.duplicates == [] and a.inconsistencies == []


def test_analysis_includes_duplicates_and_inconsistencies(conn, fee_ws):
    a = analyze(conn, fee_ws.dataset_id)
    assert a.duplicates and a.inconsistencies
    assert get_analysis(conn, fee_ws.dataset_id) == a


# ---- routes ---------------------------------------------------------------------------------------

@pytest.fixture
def api_ws(client):
    client.post("/api/auth/signup", json=CREDS)
    ws_id = client.post("/api/workspaces", json={"name": "Cleanup"}).json()["id"]
    client.post(f"/api/workspaces/{ws_id}/dataset/sample", json={"name": "fee_register"})
    client.post(f"/api/workspaces/{ws_id}/analyze")
    return ws_id


def test_routes_merge_dismiss_fix(client, api_ws):
    base = f"/api/workspaces/{api_ws}"
    a = client.get(f"{base}/analysis").json()
    g = next(d for d in a["duplicates"] if d["canonical_value"] == "Riya Sharma")
    assert set(g) == {"id", "column", "canonical_value", "confidence", "max_similarity", "status", "values"}
    assert set(g["values"][0]) == {"value", "rows"}

    merged = client.post(f"{base}/duplicates/{g['id']}/merge", json={})
    assert merged.status_code == 200
    body = merged.json()
    assert next(d for d in body["duplicates"] if d["canonical_value"] == "Riya Sharma")["status"] == "merged"

    other = next(d for d in body["duplicates"] if d["canonical_value"] == "Aman Verma")
    dismissed = client.post(f"{base}/duplicates/{other['id']}/dismiss").json()
    assert next(d for d in dismissed["duplicates"] if d["canonical_value"] == "Aman Verma")["status"] == "dismissed"

    inc = next(i for i in dismissed["inconsistencies"] if i["lhs"] == ["teacher"])
    assert set(inc) == {"fd_id", "sentence", "lhs", "rhs", "conflicts"}
    assert set(inc["conflicts"][0]) == {"lhs_values", "variants", "suggested"}
    fixed = client.post(f"{base}/inconsistencies/{inc['fd_id']}/fix", json={"overrides": None})
    assert fixed.status_code == 200
    assert not any(i["lhs"] == ["teacher"] for i in fixed.json()["inconsistencies"])

    fixes = client.get(f"{base}/fixes").json()
    assert {f["kind"] for f in fixes} == {"merge", "fd_fix"}
    assert set(fixes[0]) == {"id", "kind", "column", "from_value", "to_value", "rows_affected", "created_at"}
    assert [f["id"] for f in fixes] == sorted((f["id"] for f in fixes), reverse=True)


def test_route_accept_all(client, api_ws):
    r = client.post(f"/api/workspaces/{api_ws}/cleanup/accept-all")
    assert r.status_code == 200
    body = r.json()
    assert all(f["is_exact"] for f in body["fds"] if f["accepted"]) and body["inconsistencies"] == []


def test_cleanup_routes_guard(client, second_client, api_ws):
    base = f"/api/workspaces/{api_ws}"
    g = client.get(f"{base}/analysis").json()["duplicates"][0]
    assert second_client.post(f"{base}/cleanup/accept-all").status_code == 401
    second_client.post("/api/auth/signup", json={"email": "o@x.com", "password": "another pass",
                                                  "display_name": "O"})
    assert second_client.post(f"{base}/cleanup/accept-all").status_code == 404
    mine = second_client.post("/api/workspaces", json={"name": "Mine"}).json()["id"]
    second_client.post(f"/api/workspaces/{mine}/dataset/sample", json={"name": "fee_register"})
    # group and dependency ids from another workspace are invisible
    r = second_client.post(f"/api/workspaces/{mine}/duplicates/{g['id']}/merge", json={})
    assert r.status_code == 404 and r.json()["error"]["code"] == "group_not_found"
    r = second_client.post(f"/api/workspaces/{mine}/inconsistencies/999999/fix", json={})
    assert r.status_code == 404 and r.json()["error"]["code"] == "fd_not_found"
    r = client.post(f"{base}/duplicates/{g['id']}/merge", json={"canonical": "Nobody"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "bad_canonical"


def test_module_surface():
    assert {"find_duplicates", "inconsistencies", "merge_group", "dismiss_group", "fix_fd", "accept_all",
            "list_fixes"} <= set(dir(cleanup))
