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
    # Re-running detection replaces the pending groups instead of piling up copies.
    assert len(again.duplicates) == len(a.duplicates)


def ds_of(conn, ws_id):
    return conn.execute("SELECT id FROM qlens.datasets WHERE workspace_id = %s", (ws_id,)).fetchone()["id"]


def test_typo_is_rarer_than_the_correct_spelling(conn, workspace):
    rows = ["City,Row"] + [f"Bangalore,{i}" for i in range(20)] + [f"Banglore,{i}" for i in range(20, 22)]         + [f"Mumbai,{i}" for i in range(22, 30)]
    import_dataset(conn, workspace, "t.csv", "\n".join(rows).encode(), "upload")
    a = analyze(conn, ds_of(conn, workspace))
    g = next(d for d in a.duplicates if d.column == "city")
    assert g.confidence == "similar" and g.canonical_value == "Bangalore"
    assert {(v.value, v.rows) for v in g.values} == {("Bangalore", 20), ("Banglore", 2)}
    assert 0.5 <= g.max_similarity < 1 and len(a.duplicates) == 1


def test_equally_frequent_lookalikes_are_not_grouped(conn, workspace):
    rows = ["Name,Row"] + [f"Ananya,{i}" for i in range(10)] + [f"Anaya,{i}" for i in range(10, 20)]
    import_dataset(conn, workspace, "t.csv", "\n".join(rows).encode(), "upload")
    assert analyze(conn, ds_of(conn, workspace)).duplicates == []


def test_similar_groups_per_sample(conn, fee_ws, kirana_ws, hostel_ws):
    # Real people and items occur as often as each other; only the planted variants are suggested.
    for ws in (fee_ws, kirana_ws, hostel_ws):
        a = analyze(conn, ws.dataset_id)
        assert [d for d in a.duplicates if d.confidence == "similar"] == []
        assert {d.confidence for d in a.duplicates} == {"same_normalized"}
    fee = analyze(conn, fee_ws.dataset_id)
    assert not any({"Priya Sharma", "Riya Sharma"} <= {v.value for v in d.values} for d in fee.duplicates)


def test_find_duplicates_on_5000_distinct_values(conn, workspace):
    import random
    rng = random.Random(7)
    syl = ["ra", "mo", "ki", "sha", "an", "ve", "lu", "dar", "ti", "pre", "nan", "jay", "ku", "mar", "sai", "gop"]
    names = set()
    while len(names) < 5000:
        names.add(" ".join("".join(rng.choices(syl, k=rng.randint(2, 3))).title() for _ in range(2)))
    rows = ["Name,Row"] + [f"{n},{i}" for i, n in enumerate(sorted(names))]
    import_dataset(conn, workspace, "t.csv", "\n".join(rows).encode(), "upload")
    ds = ds_of(conn, workspace)
    import time
    t = time.perf_counter()
    find_duplicates(conn, ds)
    elapsed = time.perf_counter() - t
    print(f"find_duplicates over 5000 distinct values took {elapsed:.2f}s")
    assert elapsed < 5


def test_similar_but_not_identical_values(conn, workspace):
    rows = ["Shop,Item"] + [f"Sharma Traders,{i}" for i in range(6)] + ["Sharma Trader,x"]         + [f"Gupta Stores,{i}" for i in range(3)] + ["Verma Kirana,y"]
    import_dataset(conn, workspace, "t.csv", "\n".join(rows).encode(), "upload")
    a = analyze(conn, ds_of(conn, workspace))
    g = next(d for d in a.duplicates if d.column == "shop")
    assert g.confidence == "similar" and g.canonical_value == "Sharma Traders"
    assert {v.value for v in g.values} == {"Sharma Traders", "Sharma Trader"}
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


# ---- fix_fd / merge_group edge cases ----------------------------------------------------------------

def csv_ds(conn, ws_id, header, rows):
    body = "\n".join([header] + [",".join(r) for r in rows]).encode("utf-8")
    import_dataset(conn, ws_id, "t.csv", body, "upload")
    return ds_of(conn, ws_id)


def fd_of(a, lhs, rhs):
    return next(f for f in a.fds if f.lhs == lhs and f.rhs == rhs)


def snapshot(conn, ws_id, ds):
    """Everything a failed edit must leave alone."""
    return (conn.execute(f"SELECT * FROM {src(conn, ws_id)} ORDER BY _row_id").fetchall(),
            conn.execute("SELECT * FROM qlens.dataset_fixes ORDER BY id").fetchall(),
            conn.execute("SELECT name, null_count, distinct_count, sample_values FROM qlens.dataset_columns "
                         "WHERE dataset_id = %s ORDER BY ordinal", (ds,)).fetchall(),
            conn.execute("SELECT id, canonical_value, status FROM qlens.duplicate_groups ORDER BY id").fetchall())


def pair_table(conn, ws_id):
    """(a, b) -> c over 12 groups of 5 rows; a is NULL in three of them; one row of group (NULL, q) is wrong."""
    rows = []
    for a in ("x", "y", "z", ""):
        for b in ("p", "q", "r"):
            for i in range(5):
                c = f"{a or 'nil'}-{b}"
                if (a, b, i) == ("", "q", 0):
                    c = "oops"
                rows.append((a, b, c, str(len(rows))))
    return csv_ds(conn, ws_id, "A,B,C,N", rows)


def test_fix_fd_with_null_in_lhs_touches_only_the_conflicting_group(conn, workspace):
    ds = pair_table(conn, workspace)
    a = analyze(conn, ds)
    assert conn.execute("SELECT null_count FROM qlens.dataset_columns WHERE dataset_id = %s AND name = 'a'",
                        (ds,)).fetchone()["null_count"] == 15
    fd = fd_of(a, ["a", "b"], "c")
    assert not fd.is_exact and fd.violating_rows == 1
    inc = next(i for i in inconsistencies(conn, ds) if i.fd_id == fd.id)
    assert [c.lhs_values for c in inc.conflicts] == [[None, "q"]]
    before = conn.execute(f"SELECT _row_id, c FROM {src(conn, workspace)} ORDER BY _row_id").fetchall()

    assert fix_fd(conn, ds, fd.id, None) == 1

    after = conn.execute(f"SELECT _row_id, c FROM {src(conn, workspace)} ORDER BY _row_id").fetchall()
    changed = [(b["_row_id"], b["c"], x["c"]) for b, x in zip(before, after) if b["c"] != x["c"]]
    assert changed == [(changed[0][0], "oops", "nil-q")]
    assert next(f for f in analyze(conn, ds).fds if f.lhs == ["a", "b"] and f.rhs == "c").is_exact


def test_fix_fd_override_in_json_stringify_form(conn, workspace):
    ds = pair_table(conn, workspace)
    fd = fd_of(analyze(conn, ds), ["a", "b"], "c")
    # JS JSON.stringify: no space after the comma. The group's own key is '[null, "q"]'.
    assert fix_fd(conn, ds, fd.id, {'[null,"q"]': "oops"}) == 4
    c = conn.execute(f"SELECT DISTINCT c FROM {src(conn, workspace)} WHERE a IS NULL AND b = 'q'").fetchall()
    assert [r["c"] for r in c] == ["oops"]


def test_fix_fd_override_with_raw_non_ascii_key(conn, workspace):
    rows = [(k, "typo" if (k == "José" and i == 0) else f"v-{k}", str(n))
            for n, (k, i) in enumerate((k, i) for k in ("José", "Zoë", "Anna", "Ben") for i in range(50))]
    ds = csv_ds(conn, workspace, "Name,Val,N", rows)
    fd = fd_of(analyze(conn, ds), ["name"], "val")
    assert fix_fd(conn, ds, fd.id, {'["José"]': "typo"}) == 49          # raw é, not é
    vals = {r["val"] for r in conn.execute(f"SELECT val FROM {src(conn, workspace)} WHERE name = 'José'")}
    assert vals == {"typo"}


def null_rhs_table(conn, ws_id):
    """k -> v over 40 groups of 5. k01: one NULL among five (minority). k02: four NULL and one value."""
    rows = []
    for g in range(1, 41):
        for i in range(5):
            v = f"v{g:02d}"
            if g == 1 and i == 0:
                v = ""
            if g == 2 and i != 0:
                v = ""
            rows.append((f"k{g:02d}", v, str(len(rows))))
    return csv_ds(conn, ws_id, "K,V,N", rows)


def test_fix_fd_with_null_rhs_variants(conn, workspace):
    ds = null_rhs_table(conn, workspace)
    a = analyze(conn, ds)
    fd = fd_of(a, ["k"], "v")
    inc = next(i for i in inconsistencies(conn, ds) if i.fd_id == fd.id)
    by_key = {c.lhs_values[0]: c for c in inc.conflicts}
    assert {(v.value, v.rows) for v in by_key["k01"].variants} == {("v01", 4), (None, 1)}
    assert by_key["k01"].suggested == "v01"
    assert {(v.value, v.rows) for v in by_key["k02"].variants} == {("v02", 1), (None, 4)}
    assert by_key["k02"].suggested is None                       # NULL is the majority value

    assert fix_fd(conn, ds, fd.id, None) == 2
    rows = conn.execute(f"SELECT k, v FROM {src(conn, workspace)} WHERE k IN ('k01', 'k02')").fetchall()
    assert {r["v"] for r in rows if r["k"] == "k01"} == {"v01"}
    assert {r["v"] for r in rows if r["k"] == "k02"} == {None}
    logged = {(f["from_value"], f["to_value"], f["rows_affected"]) for f in conn.execute(
        "SELECT from_value, to_value, rows_affected FROM qlens.dataset_fixes")}
    assert logged == {(None, "v01", 1), ("v02", None, 1)}
    col = conn.execute("SELECT null_count FROM qlens.dataset_columns WHERE dataset_id = %s AND name = 'v'",
                       (ds,)).fetchone()
    assert col["null_count"] == 5                                # profile follows the edit (was 1 + 4)


def test_fix_fd_bad_override_value_changes_nothing(conn, kirana_ws):
    ds = kirana_ws.dataset_id
    fd = fd_of(analyze(conn, ds), ["item"], "unit_price")
    conflict = next(i for i in inconsistencies(conn, ds) if i.fd_id == fd.id).conflicts[0]
    before = snapshot(conn, kirana_ws.id, ds)
    with pytest.raises(ApiError) as e:
        fix_fd(conn, ds, fd.id, {json.dumps(conflict.lhs_values): "not a price"})
    assert e.value.status == 422 and e.value.code == "invalid_override_value"
    assert snapshot(conn, kirana_ws.id, ds) == before
    # the connection is still usable and the untouched dependency can be fixed afterwards
    assert fix_fd(conn, ds, fd.id, None) == 3


def test_fix_fd_rejects_unknown_and_malformed_override_keys(conn, fee_ws):
    ds = fee_ws.dataset_id
    fd = fd_of(analyze(conn, ds), ["teacher"], "teacher_phone")
    before = snapshot(conn, fee_ws.id, ds)
    for key, code in (('["Nobody"]', "unknown_override"), ("not json", "invalid_override"),
                      ('["Mr. Gupta", "extra"]', "unknown_override")):
        with pytest.raises(ApiError) as e:
            fix_fd(conn, ds, fd.id, {key: "+91 90000 00000"})
        assert e.value.status == 422 and e.value.code == code
    assert snapshot(conn, fee_ws.id, ds) == before
    # a valid key next to an unknown one: nothing is written either
    with pytest.raises(ApiError):
        fix_fd(conn, ds, fd.id, {'["Mr. Gupta"]': "+91 90000 00000", '["Nobody"]': "x"})
    assert snapshot(conn, fee_ws.id, ds) == before


def test_failed_merge_changes_nothing(conn, fee_ws):
    ds = fee_ws.dataset_id
    g = group_of(analyze(conn, ds), "Riya Sharma")
    before = snapshot(conn, fee_ws.id, ds)
    with pytest.raises(ApiError) as e:
        merge_group(conn, ds, g.id, "Somebody Else")
    assert e.value.code == "bad_canonical"
    assert snapshot(conn, fee_ws.id, ds) == before


def test_route_fix_with_bad_override(client, api_ws):
    base = f"/api/workspaces/{api_ws}"
    inc = next(i for i in client.get(f"{base}/analysis").json()["inconsistencies"] if i["lhs"] == ["teacher"])
    r = client.post(f"{base}/inconsistencies/{inc['fd_id']}/fix", json={"overrides": {'["Nobody"]': "x"}})
    assert r.status_code == 422 and r.json()["error"]["code"] == "unknown_override"
    assert client.get(f"{base}/fixes").json() == []
