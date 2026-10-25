"""The Data step: browse and edit the applied tables, with the database's own constraints pushing back."""
import pytest

from qlens.design import ddl
from qlens.design.proposal import build

FIXTURE_USER = {"email": "fixture1@example.com", "password": "fixture-password"}  # owner of applied_fee


@pytest.fixture
def ws_id(client, applied_fee) -> int:
    assert client.post("/api/auth/login", json=FIXTURE_USER).status_code == 200
    return applied_fee.id


def _url(ws_id: int, path: str = "") -> str:
    return f"/api/workspaces/{ws_id}{path}"


def _first(client, ws_id, table, **params) -> dict:
    r = client.get(_url(ws_id, f"/data/{table}"), params={"page_size": 1, **params})
    assert r.status_code == 200, r.text
    return r.json()["rows"][0]


def _changes(conn, ws_id) -> list[dict]:
    return conn.execute("SELECT table_name, op, row_pk, before, after FROM qlens.row_changes "
                        "WHERE workspace_id = %s ORDER BY id", (ws_id,)).fetchall()


# ---- apply attaches the audit trigger -------------------------------------------------------------

def test_render_adds_an_audit_trigger_per_table_after_the_loads(conn, fee_ws_clean):
    steps = ddl.render(build(conn, fee_ws_clean.dataset_id), fee_ws_clean.id)
    kinds = [s.kind for s in steps]
    assert kinds.count("trigger") == 4
    # After every load, so the bulk copy of the sheet is not logged as 3,309 inserts.
    assert max(i for i, k in enumerate(kinds) if k == "insert") < kinds.index("trigger")
    text = ddl.as_text(steps, conn)
    assert (f"CREATE TRIGGER log_row_change AFTER INSERT OR UPDATE OR DELETE ON ws_{fee_ws_clean.id}.students\n"
            "FOR EACH ROW EXECUTE FUNCTION qlens.log_row_change()") in text


def test_apply_bulk_load_writes_no_audit_rows(conn, applied_fee):
    assert _changes(conn, applied_fee.id) == []
    triggers = conn.execute(
        "SELECT c.relname FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid "
        "JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = %s AND g.tgname = 'log_row_change' "
        "ORDER BY 1", (f"ws_{applied_fee.id}",)).fetchall()
    assert [t["relname"] for t in triggers] == ["batches", "fee_register", "students", "teachers"]


def test_trigger_logs_before_and_after(conn, applied_fee):
    ws = f"ws_{applied_fee.id}"
    conn.execute(f"UPDATE {ws}.teachers SET teacher_phone = '9000000001' WHERE id = 1")
    conn.execute(f"DELETE FROM {ws}.fee_register WHERE id = 1")
    [upd, dele] = _changes(conn, applied_fee.id)
    assert (upd["table_name"], upd["op"], upd["row_pk"]) == ("teachers", "UPDATE", 1)
    assert upd["after"]["teacher_phone"] == "9000000001" and upd["before"]["teacher_phone"] != "9000000001"
    assert (dele["op"], dele["row_pk"], dele["after"]) == ("DELETE", 1, None) and dele["before"]["id"] == 1


# ---- browse ---------------------------------------------------------------------------------------

def test_list_rows_with_columns_and_paging(client, ws_id):
    r = client.get(_url(ws_id, "/data/students"), params={"page": 2, "page_size": 10})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 300 and body["page"] == 2 and body["page_size"] == 10 and len(body["rows"]) == 10
    assert [r["id"] for r in body["rows"]] == list(range(11, 21))
    cols = {c["name"]: c for c in body["columns"]}
    assert list(cols) == ["id", "student_name", "student_phone", "batch_id"]
    assert cols["id"]["is_pk"] and cols["student_name"]["not_null"] and cols["student_name"]["data_type"] == "text"
    assert cols["batch_id"]["fk"] == {"table": "batches", "column": "id"}
    assert ["student_name"] in body["unique_keys"]
    # Foreign keys come with a readable label for each id on the page.
    labels = body["fk_labels"]["batch_id"]
    assert all(str(row["batch_id"]) in labels for row in body["rows"])


def test_sort_and_search(client, ws_id):
    desc = client.get(_url(ws_id, "/data/students"), params={"sort": "student_name", "dir": "desc"}).json()
    names = [r["student_name"] for r in desc["rows"]]
    assert names == sorted(names, reverse=True)
    name = names[0]
    found = client.get(_url(ws_id, "/data/students"), params={"q": name.upper()[:6]}).json()
    assert found["total"] >= 1 and all(name.upper()[:6] in r["student_name"].upper() for r in found["rows"])
    # Wildcards in the search are literal.
    assert client.get(_url(ws_id, "/data/students"), params={"q": "%"}).json()["total"] == 0
    # The fact table can be searched by what its foreign keys stand for.
    named = {r["id"] for r in client.get(_url(ws_id, "/data/students"), params={"q": name}).json()["rows"]}
    fees = client.get(_url(ws_id, "/data/fee_register"), params={"q": name}).json()
    assert fees["total"] >= 1 and all(r["student_id"] in named for r in fees["rows"])


def test_bad_names_are_rejected(client, ws_id):
    assert client.get(_url(ws_id, '/data/students"; DROP TABLE students; --')).status_code == 404
    assert client.get(_url(ws_id, "/data/original_sheet")).status_code == 404
    r = client.get(_url(ws_id, "/data/students"), params={"sort": 'id"; DROP TABLE students; --'})
    assert r.status_code == 422 and r.json()["error"]["code"] == "unknown_column"
    r = client.post(_url(ws_id, "/data/students"), json={"values": {'student_name" text); --': "x"}})
    assert r.status_code == 422 and r.json()["error"]["code"] == "unknown_column"
    assert client.get(_url(ws_id, "/data/students")).json()["total"] == 300
    r = client.get(_url(ws_id, "/data/students"), params={"page_size": 101})
    assert r.status_code == 422


def test_data_needs_an_applied_design(client, fee_ws_clean):
    assert client.post("/api/auth/login", json=FIXTURE_USER).status_code == 200
    r = client.get(_url(fee_ws_clean.id, "/data/students"))
    assert r.status_code == 404 and r.json()["error"]["code"] == "table_not_found"


def test_other_users_workspace_is_hidden(client, ws_id, other_applied_ws):
    assert client.get(_url(other_applied_ws.id, "/data/students")).status_code == 404


def test_fk_options_use_the_natural_key(client, ws_id):
    r = client.get(_url(ws_id, "/data/students/options/batch_id"))
    assert r.status_code == 200, r.text
    opts = r.json()
    assert len(opts) >= 1 and all(set(o) == {"id", "label"} for o in opts)
    batches = client.get(_url(ws_id, "/data/batches"), params={"page_size": 100}).json()["rows"]
    assert {o["label"] for o in opts} <= {b["batch"] for b in batches}
    one = opts[0]["label"]
    found = [o["label"] for o in client.get(_url(ws_id, "/data/students/options/batch_id"), params={"q": one}).json()]
    assert one in found and all(one.lower() in f.lower() for f in found)
    assert client.get(_url(ws_id, "/data/students/options/student_name")).status_code == 422


# ---- write ----------------------------------------------------------------------------------------

def test_crud_round_trip_is_audited(client, conn, ws_id):
    batch = _first(client, ws_id, "batches")["id"]
    r = client.post(_url(ws_id, "/data/students"),
                    json={"values": {"student_name": "Zoya Test", "student_phone": "9999911111", "batch_id": batch}})
    assert r.status_code == 201, r.text
    row = r.json()
    assert row["id"] > 300 and row["student_name"] == "Zoya Test" and row["batch_id"] == batch

    r = client.patch(_url(ws_id, f"/data/students/{row['id']}"), json={"values": {"student_phone": "9999922222"}})
    assert r.status_code == 200 and r.json()["student_phone"] == "9999922222"

    assert client.delete(_url(ws_id, f"/data/students/{row['id']}")).status_code == 204
    assert client.delete(_url(ws_id, f"/data/students/{row['id']}")).status_code == 404
    assert client.patch(_url(ws_id, f"/data/students/{row['id']}"),
                        json={"values": {"student_phone": "1"}}).status_code == 404

    log = client.get(_url(ws_id, "/data-changes"), params={"limit": 10}).json()
    # Three changes, all to one row.
    assert (log["change_count"], log["edited_rows"]) == (3, 1)
    assert [c["op"] for c in log["changes"]] == ["DELETE", "UPDATE", "INSERT"]
    upd = log["changes"][1]
    assert upd["table_name"] == "students" and upd["row_pk"] == row["id"]
    assert (upd["before"]["student_phone"], upd["after"]["student_phone"]) == ("9999911111", "9999922222")


def test_id_is_not_writable(client, ws_id):
    r = client.post(_url(ws_id, "/data/teachers"), json={"values": {"id": 99, "teacher": "X", "teacher_phone": "1"}})
    assert r.status_code == 422 and r.json()["error"]["code"] == "column_not_writable"


def test_unique_violation(client, ws_id):
    existing = _first(client, ws_id, "students")
    r = client.post(_url(ws_id, "/data/students"), json={"values": {
        "student_name": existing["student_name"], "student_phone": "9999933333", "batch_id": existing["batch_id"]}})
    assert r.status_code == 409
    err = r.json()["error"]
    assert err["code"] == "unique_violation"
    assert err["message"] == f"A student named {existing['student_name']} already exists."
    d = err["detail"]
    assert (d["constraint"], d["columns"], d["sqlstate"], d["kind"]) == (
        "students_student_name_key", ["student_name"], "23505", "unique")


def test_unique_violation_on_a_column_named_after_its_table(client, ws_id):
    existing = _first(client, ws_id, "teachers")
    r = client.patch(_url(ws_id, "/data/teachers/2" if existing["id"] == 1 else "/data/teachers/1"),
                     json={"values": {"teacher": existing["teacher"]}})
    assert r.status_code == 409
    assert r.json()["error"]["message"] == f"A teacher named {existing['teacher']} already exists."


def test_fk_violation_on_insert(client, ws_id):
    r = client.post(_url(ws_id, "/data/fee_register"), json={"values": {
        "student_id": 987654, "month": "2026-01", "fee_paid": "1500", "payment_mode": "UPI"}})
    assert r.status_code == 409
    err = r.json()["error"]
    assert err["code"] == "foreign_key_violation" and err["message"].startswith("No such student")
    d = err["detail"]
    assert (d["constraint"], d["columns"], d["sqlstate"], d["referenced_table"]) == (
        "fee_register_student_id_fkey", ["student_id"], "23503", "students")
    # The rule as PostgreSQL itself prints it, for the UI to show next to the plain-English message.
    assert d["definition"].startswith("FOREIGN KEY (student_id) REFERENCES ") and "ON DELETE RESTRICT" in d["definition"]


def test_fk_violation_on_delete_is_restricted(client, conn, ws_id):
    student = _first(client, ws_id, "students")
    n = conn.execute(f"SELECT count(*) AS n FROM ws_{ws_id}.fee_register WHERE student_id = %s",
                     (student["id"],)).fetchone()["n"]
    assert n > 0
    r = client.delete(_url(ws_id, f"/data/students/{student['id']}"))
    assert r.status_code == 409
    err = r.json()["error"]
    assert err["code"] == "foreign_key_violation"
    rows = "record" if n == 1 else "records"
    assert err["message"] == (f"This student is referenced by {n} fee register {rows}; "
                              "delete or reassign them first.")
    d = err["detail"]
    assert (d["constraint"], d["referencing_table"], d["referencing_rows"], d["sqlstate"]) == (
        "fee_register_student_id_fkey", "fee_register", n, "23001")   # restrict_violation
    assert client.get(_url(ws_id, "/data/students")).json()["total"] == 300
    assert client.get(_url(ws_id, "/data-changes")).json()["changes"] == []


def test_not_null_violation(client, ws_id):
    r = client.post(_url(ws_id, "/data/teachers"), json={"values": {"teacher": None, "teacher_phone": "123"}})
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["code"] == "not_null_violation" and err["detail"]["columns"] == ["teacher"]
    assert err["detail"]["sqlstate"] == "23502" and "teacher" in err["message"]
    assert err["detail"]["definition"] == "NOT NULL teacher"


def test_check_violation(client, conn, ws_id):
    conn.execute(f"ALTER TABLE ws_{ws_id}.fee_register ADD CONSTRAINT fee_paid_not_negative CHECK (fee_paid >= 0)")
    conn.commit()
    row = _first(client, ws_id, "fee_register")
    r = client.patch(_url(ws_id, f"/data/fee_register/{row['id']}"), json={"values": {"fee_paid": "-5"}})
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["code"] == "check_violation" and "fee_paid >= 0" in err["message"]
    assert (err["detail"]["constraint"], err["detail"]["columns"], err["detail"]["sqlstate"]) == (
        "fee_paid_not_negative", ["fee_paid"], "23514")


def test_invalid_input_names_the_column(client, ws_id):
    row = _first(client, ws_id, "fee_register")
    r = client.patch(_url(ws_id, f"/data/fee_register/{row['id']}"), json={"values": {"fee_paid": "lots"}})
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["code"] == "invalid_input" and err["detail"]["columns"] == ["fee_paid"]
    assert err["detail"]["sqlstate"] == "22P02" and "invalid input syntax for type bigint" in err["message"]


def test_edited_rows_reset_on_reapply(client, conn, ws_id, applied_fee):
    from qlens.design.apply import apply_proposal

    row = _first(client, ws_id, "teachers")
    client.patch(_url(ws_id, f"/data/teachers/{row['id']}"), json={"values": {"teacher_phone": "9000000009"}})
    assert client.get(_url(ws_id, "/data-changes")).json()["edited_rows"] == 1
    apply_proposal(conn, applied_fee.id, build(conn, applied_fee.dataset_id).id)
    conn.commit()
    assert client.get(_url(ws_id, "/data-changes")).json() == {"edited_rows": 0, "change_count": 0, "changes": []}


# ---- filters, related records, CSV export ---------------------------------------------------------

def _rows(client, ws_id, table, **params) -> dict:
    r = client.get(_url(ws_id, f"/data/{table}"), params={"page_size": 100, **params})
    assert r.status_code == 200, r.text
    return r.json()


def test_filter_operators(client, ws_id):
    one = _rows(client, ws_id, "students", f="id:eq:7")
    assert one["total"] == 1 and one["rows"][0]["id"] == 7
    name = one["rows"][0]["student_name"]
    first = name.split()[0]
    contains = _rows(client, ws_id, "students", f=f"student_name:contains:{first.lower()}")
    assert contains["total"] >= 1 and all(first.lower() in r["student_name"].lower() for r in contains["rows"])
    big = _rows(client, ws_id, "fee_register", f="fee_paid:gt:3000")
    assert big["total"] > 0 and all(r["fee_paid"] > 3000 for r in big["rows"])
    small = _rows(client, ws_id, "fee_register", f="fee_paid:lt:3000")
    assert small["total"] > 0 and all(r["fee_paid"] < 3000 for r in small["rows"])
    empty = _rows(client, ws_id, "fee_register", f="payment_mode:empty")
    assert empty["total"] > 0 and all(r["payment_mode"] is None for r in empty["rows"])
    # Several filters are ANDed, and combine with the search box.
    both = _rows(client, ws_id, "fee_register", f=["fee_paid:gt:3000", "payment_mode:eq:UPI"])
    assert both["total"] > 0 and all(r["fee_paid"] > 3000 and r["payment_mode"] == "UPI" for r in both["rows"])
    # A value with colons in it is kept whole.
    assert _rows(client, ws_id, "students", f="student_name:eq:a:b")["total"] == 0


def test_filter_on_a_foreign_key(client, ws_id):
    student = _first(client, ws_id, "students")
    by_id = _rows(client, ws_id, "fee_register", f=f"student_id:eq:{student['id']}")
    assert by_id["total"] > 0 and all(r["student_id"] == student["id"] for r in by_id["rows"])
    # contains on a foreign key matches what it stands for (the student's name).
    by_name = _rows(client, ws_id, "fee_register", f=f"student_id:contains:{student['student_name']}")
    assert by_name["total"] == by_id["total"]


def test_bad_filters_are_422(client, ws_id):
    for f, code in [("nope:eq:1", "unknown_column"), ("id:like:1", "invalid_filter"), ("id", "invalid_filter"),
                    ("fee_paid:gt:lots", "invalid_filter"), ('id"; DROP TABLE x; --:eq:1', "unknown_column")]:
        r = client.get(_url(ws_id, "/data/fee_register"), params={"f": f})
        assert r.status_code == 422, (f, r.text)
        assert r.json()["error"]["code"] == code, f
    r = client.get(_url(ws_id, "/data/fee_register"), params={"f": "fee_paid:gt:lots"})
    assert "fee_paid" in r.json()["error"]["message"]


def test_related_records(client, conn, ws_id):
    student = _first(client, ws_id, "students")
    r = client.get(_url(ws_id, f"/data/students/{student['id']}/related"))
    assert r.status_code == 200, r.text
    [fees] = r.json()
    n = conn.execute(f"SELECT count(*) AS n FROM ws_{ws_id}.fee_register WHERE student_id = %s",
                     (student["id"],)).fetchone()["n"]
    assert (fees["table"], fees["column"], fees["total"]) == ("fee_register", "student_id", n)
    assert 0 < len(fees["rows"]) <= 5 and all(x["student_id"] == student["id"] for x in fees["rows"])
    assert [c["name"] for c in fees["columns"]][:2] == ["id", "student_id"]
    assert isinstance(fees["color_index"], int)
    # A batch is referenced by students; a fee record by nothing.
    assert [g["table"] for g in client.get(_url(ws_id, "/data/batches/1/related")).json()] == ["students"]
    assert client.get(_url(ws_id, "/data/fee_register/1/related")).json() == []
    assert client.get(_url(ws_id, "/data/students/999999/related")).status_code == 404


def test_csv_export_follows_the_view(client, ws_id):
    r = client.get(_url(ws_id, "/data/students/export"), params={"sort": "student_name", "dir": "desc",
                                                                  "f": "batch_id:eq:1"})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/csv")
    assert 'filename="students.csv"' in r.headers["content-disposition"]
    lines = r.text.splitlines()
    assert lines[0] == "id,student_name,student_phone,batch_id,batch_id_label"
    view = _rows(client, ws_id, "students", sort="student_name", dir="desc", f="batch_id:eq:1")
    assert len(lines) - 1 == view["total"] > 0
    first = lines[1].split(",")
    assert int(first[0]) == view["rows"][0]["id"] and first[3] == "1"
    assert first[4] == view["fk_labels"]["batch_id"]["1"]
    assert client.get(_url(ws_id, "/data/nope/export")).status_code == 404
