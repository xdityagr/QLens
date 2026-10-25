from urllib.parse import urlsplit

import psycopg
import pytest
from psycopg import sql
from psycopg.rows import dict_row

from qlens import db
from qlens.analysis.cleanup import accept_all
from qlens.config import get_settings
from qlens.design import ddl
from qlens.design.apply import apply_proposal
from qlens.design.catalog import describe
from qlens.design.proposal import build
from qlens.errors import ApiError
from qlens.ingest.stage import import_dataset

FIXTURE_LOGIN = {"email": "fixture1@example.com", "password": "fixture-password"}


def status_of(conn, proposal_id):
    return conn.execute("SELECT status FROM qlens.schema_proposals WHERE id = %s", (proposal_id,)).fetchone()["status"]


def main_tables(conn, ws_id):
    return {r["relname"] for r in conn.execute(
        "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = %s AND c.relkind = 'r'", (db.ws_schema(ws_id, "main"),))}


def import_and_apply(conn, ws_id, csv_):
    ds = import_dataset(conn, ws_id, "sheet.csv", csv_, source="upload")
    accept_all(conn, ds.id)
    return apply_proposal(conn, ws_id, build(conn, ds.id).id)


# ---- apply ----------------------------------------------------------------------------------------

def test_apply_fee_register_lossless(conn, fee_ws_clean):
    p = build(conn, fee_ws_clean.dataset_id)
    out = apply_proposal(conn, fee_ws_clean.id, p.id)
    assert out.ok and out.lossless_ok and out.staging_rows == out.reconstructed_rows == 3000 and out.mismatch_rows == 0
    counts = {t["name"]: t["row_count"] for t in out.tables}
    assert list(counts) == [t.name for t in p.tables]
    assert (counts["teachers"], counts["students"], counts["fee_register"]) == (6, 300, 3000)
    assert [t["color_index"] for t in out.tables] == [t.color_index for t in p.tables]
    assert out.duration_ms >= 0 and f"CREATE TABLE ws_{fee_ws_clean.id}.students (" in out.sql
    row = conn.execute("SELECT status, lossless_ok, applied_at, staging_rows, reconstructed_rows, mismatch_rows "
                       "FROM qlens.schema_proposals WHERE id = %s", (p.id,)).fetchone()
    assert (row["status"], row["lossless_ok"], row["staging_rows"], row["reconstructed_rows"],
            row["mismatch_rows"]) == ("applied", True, 3000, 3000, 0) and row["applied_at"] is not None
    ds = conn.execute("SELECT status FROM qlens.datasets WHERE id = %s", (fee_ws_clean.dataset_id,)).fetchone()
    assert ds["status"] == "applied"
    # ANALYZE ran: the planner has statistics for the new tables.
    analyzed = conn.execute("SELECT count(*) AS n FROM pg_stats WHERE schemaname = %s AND tablename = 'students'",
                            (f"ws_{fee_ws_clean.id}",)).fetchone()["n"]
    assert analyzed > 0


def test_reapply_supersedes_the_previous_design(conn, fee_ws_clean):
    first = build(conn, fee_ws_clean.dataset_id)
    apply_proposal(conn, fee_ws_clean.id, first.id)
    second = build(conn, fee_ws_clean.dataset_id)
    apply_proposal(conn, fee_ws_clean.id, second.id)
    assert (status_of(conn, first.id), status_of(conn, second.id)) == ("superseded", "applied")
    # Only the current draft may be applied.
    for pid in (first.id, second.id):
        with pytest.raises(ApiError) as e:
            apply_proposal(conn, fee_ws_clean.id, pid)
        assert (e.value.status, e.value.code) == (409, "proposal_not_draft")


def test_apply_rejects_a_proposal_of_another_workspace(conn, fee_ws_clean, make_workspace):
    p = build(conn, fee_ws_clean.dataset_id)
    with pytest.raises(ApiError) as e:
        apply_proposal(conn, make_workspace(), p.id)
    assert (e.value.status, e.value.code) == (404, "proposal_not_found")


def test_apply_drops_the_lab(conn, fee_ws_clean):
    db.create_ws_schema(conn, fee_ws_clean.id, "lab")
    apply_proposal(conn, fee_ws_clean.id, build(conn, fee_ws_clean.dataset_id).id)
    assert conn.execute("SELECT 1 FROM pg_namespace WHERE nspname = %s",
                        (db.ws_schema(fee_ws_clean.id, "lab"),)).fetchone() is None


def test_apply_is_atomic(conn, fee_ws_clean, monkeypatch):
    first = build(conn, fee_ws_clean.dataset_id)
    apply_proposal(conn, fee_ws_clean.id, first.id)
    conn.commit()
    draft = build(conn, fee_ws_clean.dataset_id)
    conn.execute("UPDATE qlens.proposed_tables SET name = 'learners' WHERE proposal_id = %s AND name = 'students'",
                 (draft.id,))
    conn.commit()
    monkeypatch.setattr(ddl, "_verify", lambda *a: sql.SQL("SELECT 1 / 0"))
    with pytest.raises(psycopg.errors.DivisionByZero):
        apply_proposal(conn, fee_ws_clean.id, draft.id)
    conn.rollback()
    assert main_tables(conn, fee_ws_clean.id) == {"students", "batches", "teachers", "fee_register"}
    assert (status_of(conn, first.id), status_of(conn, draft.id)) == ("applied", "draft")


def test_lossless_failure_rolls_back(conn, fee_ws_clean, monkeypatch):
    first = build(conn, fee_ws_clean.dataset_id)
    apply_proposal(conn, fee_ws_clean.id, first.id)
    conn.commit()
    draft = build(conn, fee_ws_clean.dataset_id)
    conn.commit()
    render = ddl.render

    def lossy(p, ws_id):
        # Lose two sheet rows after loading: the check must notice and undo everything.
        steps = render(p, ws_id)
        at = next(i for i, s in enumerate(steps) if s.kind == "view")
        drop = sql.SQL("DELETE FROM {} WHERE id <= 2").format(sql.Identifier(f"ws_{ws_id}", "fee_register"))
        return [*steps[:at], ddl.SqlStep("insert", "lose rows", drop), *steps[at:]]

    monkeypatch.setattr(ddl, "render", lossy)
    with pytest.raises(ApiError) as e:
        apply_proposal(conn, fee_ws_clean.id, draft.id)
    assert (e.value.status, e.value.code) == (409, "lossless_check_failed")
    assert e.value.detail["mismatch_rows"] == 2 and 1 <= len(e.value.detail["sample"]) <= 5
    sample = e.value.detail["sample"][0]
    assert sample["side"] == "missing" and set(sample["row"]) >= {"student_name", "month", "fee_paid"}
    conn.rollback()
    assert (status_of(conn, first.id), status_of(conn, draft.id)) == ("applied", "draft")
    n = conn.execute(f"SELECT count(*) AS n FROM ws_{fee_ws_clean.id}.fee_register").fetchone()["n"]
    assert n == 3000


def test_sandbox_role_can_read_applied_tables(conn, fee_ws_clean, test_url):
    apply_proposal(conn, fee_ws_clean.id, build(conn, fee_ws_clean.dataset_id).id)
    conn.commit()
    s = get_settings()
    with psycopg.connect(host=s.pg_host, port=s.pg_port, dbname=urlsplit(test_url).path.lstrip("/"),
                         user=db.ws_role(fee_ws_clean.id), password=db.ws_password(fee_ws_clean.id),
                         row_factory=dict_row) as ws:
        assert ws.execute("SELECT count(*) AS n FROM students").fetchone()["n"] == 300
        assert ws.execute("SELECT count(*) AS n FROM original_sheet").fetchone()["n"] == 3000


def test_reserved_and_quoted_identifiers(conn, workspace):
    out = import_and_apply(conn, workspace,
                           b"Order,Group,User's Name,Amount\n1,A,Asha,10\n2,A,Asha,20\n3,B,Ravi,5\n4,B,Ravi,7\n")
    assert out.lossless_ok and out.mismatch_rows == 0
    schema = describe(conn, workspace)
    assert any("group" in [c["name"] for c in t["columns"]] for t in schema.tables)


def test_null_determinant_lossless(conn, workspace):
    out = import_and_apply(conn, workspace, b"Student,Teacher,Phone\nA,T1,111\nB,T1,111\nC,,\nD,,\nE,T2,222\nF,T2,222\n")
    assert out.lossless_ok and out.staging_rows == out.reconstructed_rows == 6
    n = conn.execute(f"SELECT count(*) AS n FROM ws_{workspace}.teachers WHERE teacher IS NULL").fetchone()["n"]
    assert n == 1


def test_hostel_and_kirana_apply(conn, hostel_ws, kirana_ws):
    for ws in (hostel_ws, kirana_ws):
        accept_all(conn, ws.dataset_id)
        out = apply_proposal(conn, ws.id, build(conn, ws.dataset_id).id)
        assert out.lossless_ok and out.staging_rows == out.reconstructed_rows > 0 and out.mismatch_rows == 0


def test_applied_fee_fixture(conn, applied_fee):
    row = conn.execute("SELECT status FROM qlens.datasets WHERE id = %s", (applied_fee.dataset_id,)).fetchone()
    assert row["status"] == "applied" and "students" in main_tables(conn, applied_fee.id)


# ---- catalog --------------------------------------------------------------------------------------

def test_describe_fee_register(conn, applied_fee):
    p = conn.execute("SELECT id FROM qlens.schema_proposals WHERE dataset_id = %s AND status = 'applied'",
                     (applied_fee.dataset_id,)).fetchone()
    colors = {r["name"]: r["color_index"] for r in conn.execute(
        "SELECT name, color_index FROM qlens.proposed_tables WHERE proposal_id = %s", (p["id"],))}
    schema = describe(conn, applied_fee.id)
    tables = {t["name"]: t for t in schema.tables}
    assert set(tables) == {"students", "batches", "teachers", "fee_register"}
    assert {n: t["color_index"] for n, t in tables.items()} == colors
    assert tables["students"]["row_count"] == 300 and tables["fee_register"]["row_count"] == 3000
    students = {c["name"]: c for c in tables["students"]["columns"]}
    assert list(students) == ["id", "student_name", "student_phone", "batch_id"]
    assert students["id"]["is_pk"] and students["id"]["not_null"] and students["id"]["fk"] is None
    assert students["id"]["data_type"] == "bigint"
    assert students["batch_id"]["fk"] == {"table": "batches", "column": "id"} and not students["batch_id"]["is_pk"]
    assert students["student_name"]["data_type"] == "text"
    idx = {i["name"]: i for i in tables["students"]["indexes"]}
    assert idx["students_pkey"] == {"name": "students_pkey", "columns": ["id"], "unique": True}
    assert idx["students_student_name_key"]["columns"] == ["student_name"]
    assert {i["name"]: i["columns"] for i in tables["fee_register"]["indexes"]}[
        "fee_register_student_id_month_key"] == ["student_id", "month"]


def test_describe_defaults_and_empty_lab(conn, workspace):
    assert describe(conn, workspace).tables == []
    assert describe(conn, workspace, "lab").tables == []
    conn.execute(f"CREATE TABLE ws_{workspace}.zeta (a int)")
    conn.execute(f"CREATE TABLE ws_{workspace}.alpha (a int)")
    assert [(t["name"], t["color_index"], t["row_count"]) for t in describe(conn, workspace).tables] == [
        ("alpha", 0, 0), ("zeta", 1, 0)]


# ---- routes ---------------------------------------------------------------------------------------

def test_reapply_after_rename(client, fee_ws_clean):
    client.post("/api/auth/login", json=FIXTURE_LOGIN)
    base = f"/api/workspaces/{fee_ws_clean.id}"
    p = client.post(f"{base}/proposal").json()
    first = client.post(f"{base}/apply", json={"proposal_id": p["id"]})
    assert first.status_code == 200 and first.json()["lossless_ok"]
    assert set(first.json()) >= {"ok", "lossless_ok", "staging_rows", "reconstructed_rows", "mismatch_rows",
                                 "tables", "duration_ms", "sql"}
    again = client.post(f"{base}/apply", json={"proposal_id": p["id"]})
    assert again.status_code == 409 and again.json()["error"]["code"] == "proposal_not_draft"

    p = client.post(f"{base}/proposal").json()
    students = next(t for t in p["tables"] if t["name"] == "students")
    assert client.patch(f"{base}/proposal/tables/{students['id']}", json={"name": "learners"}).status_code == 200
    r = client.post(f"{base}/apply", json={"proposal_id": p["id"]})
    assert r.status_code == 200 and r.json()["lossless_ok"]
    assert "learners" in [t["name"] for t in r.json()["tables"]]
    schema = client.get(f"{base}/schema").json()
    names = [t["name"] for t in schema["tables"]]
    assert "learners" in names and "students" not in names
    t = schema["tables"][0]
    assert set(t) >= {"name", "color_index", "row_count", "columns", "indexes"}
    assert set(t["columns"][0]) >= {"name", "data_type", "not_null", "is_pk", "fk"}
    assert client.get(f"{base}/schema?kind=lab").json() == {"tables": []}
    assert client.get(f"{base}/schema?kind=src").status_code == 422
    # The applied design is what GET /proposal shows when there is no draft.
    assert client.get(f"{base}/proposal").json()["status"] == "applied"


def test_apply_route_errors(client, fee_ws_clean, second_client):
    client.post("/api/auth/login", json=FIXTURE_LOGIN)
    base = f"/api/workspaces/{fee_ws_clean.id}"
    r = client.post(f"{base}/apply", json={"proposal_id": 999999})
    assert r.status_code == 404 and r.json()["error"]["code"] == "proposal_not_found"
    assert second_client.post(f"{base}/apply", json={"proposal_id": 1}).status_code == 401
    assert second_client.get(f"{base}/schema").status_code == 401
