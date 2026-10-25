"""Data-changing SQL from the Data page's SQL tab: one INSERT, UPDATE or DELETE on the generated tables."""
import psycopg
import pytest
from psycopg import sql

from qlens import db
from qlens.config import get_settings

FIXTURE_USER = {"email": "fixture1@example.com", "password": "fixture-password"}  # owner of applied_fee


@pytest.fixture
def ws_id(client, applied_fee) -> int:
    assert client.post("/api/auth/login", json=FIXTURE_USER).status_code == 200
    return applied_fee.id


def _url(ws_id: int, path: str = "") -> str:
    return f"/api/workspaces/{ws_id}{path}"


def _write(client, ws_id: int, text: str):
    return client.post(_url(ws_id, "/query/write"), json={"sql": text})


def _history(client, ws_id) -> list[dict]:
    return client.get(_url(ws_id, "/history")).json()


def _as_role(ws_id: int) -> psycopg.Connection:
    """A raw connection as the workspace's sandbox role, the way the sandbox makes one."""
    s = get_settings()
    return psycopg.connect(host=s.pg_host, port=s.pg_port, dbname=s.pg_dbname, user=db.ws_role(ws_id),
                           password=db.ws_password(ws_id))


# ---- writes that work -----------------------------------------------------------------------------

def test_update_reports_affected_rows_and_the_trigger_logs_it(client, conn, ws_id):
    before = conn.execute(f"SELECT teacher_phone FROM ws_{ws_id}.teachers WHERE id IN (1, 2) ORDER BY id").fetchall()
    r = _write(client, ws_id, "UPDATE teachers SET teacher_phone = '+' || teacher_phone WHERE id IN (1, 2);")
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["statement"], body["table"], body["row_count"], body["returning"]) == ("UPDATE", "teachers", 2, None)
    assert body["duration_ms"] >= 0
    after = conn.execute(f"SELECT teacher_phone FROM ws_{ws_id}.teachers WHERE id IN (1, 2) ORDER BY id").fetchall()
    assert [a["teacher_phone"] for a in after] == ["+" + b["teacher_phone"] for b in before]
    # The audit trigger fired for the sandbox role too (it writes the log as its owner).
    changes = client.get(_url(ws_id, "/data-changes")).json()
    assert changes["change_count"] == 2 and changes["edited_rows"] == 2
    assert sorted((c["table_name"], c["op"], c["row_pk"]) for c in changes["changes"]) == [
        ("teachers", "UPDATE", 1), ("teachers", "UPDATE", 2)]
    [h] = _history(client, ws_id)
    assert (h["id"], h["source"], h["target"], h["status"], h["row_count"]) == (body["run_id"], "typed", "main", "ok", 2)
    assert h["sql_text"] == "UPDATE teachers SET teacher_phone = '+' || teacher_phone WHERE id IN (1, 2)"


def test_insert_returning_then_delete(client, ws_id):
    r = _write(client, ws_id, "INSERT INTO teachers (teacher, teacher_phone) VALUES ('Dr. New', '9000000002') "
                              "RETURNING id, teacher")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["row_count"] == 1 and body["statement"] == "INSERT"
    ret = body["returning"]
    assert [c["name"] for c in ret["columns"]] == ["id", "teacher"] and ret["truncated"] is False
    [[new_id, name]] = ret["rows"]
    assert name == "Dr. New"
    r = _write(client, ws_id, f"DELETE FROM teachers WHERE id = {new_id}")
    assert r.status_code == 200 and r.json()["row_count"] == 1
    ops = [(c["op"], c["row_pk"]) for c in client.get(_url(ws_id, "/data-changes")).json()["changes"]]
    assert ops == [("DELETE", new_id), ("INSERT", new_id)]


def test_returning_is_capped_at_50_rows(client, ws_id):
    r = _write(client, ws_id, "UPDATE fee_register SET fee_paid = fee_paid WHERE id <= 60 RETURNING id")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["row_count"] == 60 and len(body["returning"]["rows"]) == 50 and body["returning"]["truncated"]


def test_write_on_a_workspace_applied_before_the_write_grants(client, conn, ws_id):
    # Dev workspaces applied before this feature have SELECT only; the first write grants the rest.
    conn.execute(sql.SQL("REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA {} FROM {}").format(
        sql.Identifier(f"ws_{ws_id}"), sql.Identifier(db.ws_role(ws_id))))
    conn.commit()
    r = _write(client, ws_id, "UPDATE teachers SET teacher_phone = '9000000003' WHERE id = 1")
    assert r.status_code == 200, r.text
    assert r.json()["row_count"] == 1


# ---- constraints push back, in the same words as the Browse tab -----------------------------------

def test_insert_violating_a_foreign_key_is_409_with_the_constraint(client, ws_id):
    r = _write(client, ws_id, "INSERT INTO fee_register (student_id, month, fee_paid, payment_mode) "
                              "VALUES (987654, '2026-01', 1500, 'UPI')")
    assert r.status_code == 409, r.text
    err = r.json()["error"]
    assert err["code"] == "foreign_key_violation"
    assert err["message"] == "No such student: students has no row with id 987654."
    d = err["detail"]
    assert (d["constraint"], d["columns"], d["sqlstate"], d["referenced_table"], d["operation"], d["table"]) == (
        "fee_register_student_id_fkey", ["student_id"], "23503", "students", "INSERT", "fee_register")
    assert d["definition"].startswith("FOREIGN KEY (student_id) REFERENCES ")
    assert client.get(_url(ws_id, "/data-changes")).json()["change_count"] == 0
    [h] = _history(client, ws_id)
    assert h["status"] == "error" and h["source"] == "typed"


def test_delete_blocked_by_restrict_is_409(client, conn, ws_id):
    n = conn.execute(f"SELECT count(*) AS n FROM ws_{ws_id}.fee_register WHERE student_id = 3").fetchone()["n"]
    assert n > 0
    r = _write(client, ws_id, "DELETE FROM students WHERE id = 3")
    assert r.status_code == 409, r.text
    err = r.json()["error"]
    rows = "record" if n == 1 else "records"
    assert err["message"] == f"This student is referenced by {n} fee register {rows}; delete or reassign them first."
    d = err["detail"]
    assert (d["constraint"], d["referencing_table"], d["referencing_rows"], d["sqlstate"]) == (
        "fee_register_student_id_fkey", "fee_register", n, "23001")
    assert conn.execute(f"SELECT count(*) AS n FROM ws_{ws_id}.students").fetchone()["n"] == 300


def test_a_failing_row_rolls_back_the_whole_statement(client, conn, ws_id):
    # Students 1..3 all have fees: nothing is deleted, not even the rows checked before the failure.
    r = _write(client, ws_id, "DELETE FROM fee_register WHERE student_id = 1")
    assert r.status_code == 200
    r = _write(client, ws_id, "DELETE FROM students WHERE id IN (1, 3)")
    assert r.status_code == 409
    assert conn.execute(f"SELECT count(*) AS n FROM ws_{ws_id}.students").fetchone()["n"] == 300


def test_unique_violation_names_the_row(client, conn, ws_id):
    first = conn.execute(f"SELECT teacher FROM ws_{ws_id}.teachers WHERE id = 1").fetchone()["teacher"]
    r = _write(client, ws_id, "UPDATE teachers SET teacher = (SELECT teacher FROM teachers WHERE id = 1) WHERE id = 2")
    assert r.status_code == 409, r.text
    err = r.json()["error"]
    assert err["code"] == "unique_violation" and err["message"] == f"A teacher named {first} already exists."
    assert err["detail"]["sqlstate"] == "23505"


def test_not_null_violation_is_422(client, ws_id):
    r = _write(client, ws_id, "UPDATE teachers SET teacher = NULL WHERE id = 1")
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["code"] == "not_null_violation" and err["detail"]["definition"] == "NOT NULL teacher"


def test_other_database_errors_are_400_and_recorded(client, ws_id):
    r = _write(client, ws_id, "UPDATE teachers SET nope = 1")
    assert r.status_code == 400
    err = r.json()["error"]
    assert err["code"] == "db_error" and err["detail"]["sqlstate"] == "42703"
    [h] = _history(client, ws_id)
    assert h["status"] == "error"


# ---- what is refused ------------------------------------------------------------------------------

@pytest.mark.parametrize(("text", "code"), [
    ("UPDATE _staging SET fee_paid = 0", "write_target_not_allowed"),
    ("DELETE FROM _raw", "write_target_not_allowed"),
    ("DELETE FROM {src}._staging", "write_target_not_allowed"),
    ("UPDATE {lab}.fee_register SET fee_paid = 0", "write_target_not_allowed"),
    ("UPDATE {other}.fee_register SET fee_paid = 0", "write_target_not_allowed"),
    ("DELETE FROM original_sheet", "write_target_not_allowed"),
    ("DELETE FROM nosuch", "write_target_not_allowed"),
    ("TRUNCATE fee_register", "not_a_write"),
    ("DROP TABLE fee_register", "not_a_write"),
    ("CREATE TABLE extra (a int)", "not_a_write"),
    ("ALTER TABLE fee_register DROP COLUMN fee_paid", "not_a_write"),
    ("COPY fee_register TO STDOUT", "not_a_write"),
    ("SELECT * FROM students", "not_a_write"),
    ("DELETE FROM fee_register WHERE id = 1; DELETE FROM fee_register", "multiple_statements"),
    ("WITH gone AS (DELETE FROM fee_register RETURNING student_id) "
     "UPDATE students SET student_phone = '1' WHERE id IN (SELECT student_id FROM gone)", "one_write_only"),
    ("UPDATE teachers SET teacher_phone = pg_read_file('/etc/passwd')", "forbidden_function"),
    ("UPDATE teachers SET", "syntax_error"),
])
def test_refused_writes_are_422_recorded_and_change_nothing(client, conn, ws_id, other_applied_ws, text, code):
    text = text.format(src=f"ws_{ws_id}_src", lab=f"ws_{ws_id}_lab", other=f"ws_{other_applied_ws.id}")
    r = _write(client, ws_id, text)
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == code
    [h] = _history(client, ws_id)
    assert h["status"] == "error"
    assert conn.execute(f"SELECT count(*) AS n FROM ws_{ws_id}.fee_register").fetchone()["n"] == 3000
    assert conn.execute(f"SELECT count(*) AS n FROM ws_{ws_id}_src._staging").fetchone()["n"] > 0


def test_read_only_query_still_refuses_writes(client, conn, ws_id):
    r = client.post(_url(ws_id, "/query"), json={"sql": "DELETE FROM fee_register"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "not_a_select"
    # Below the checks: the role's sessions start read-only, so even a raw write is refused.
    with _as_role(ws_id) as c, pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
        c.execute(f"DELETE FROM ws_{ws_id}.fee_register WHERE id = 1")
    assert conn.execute(f"SELECT count(*) AS n FROM ws_{ws_id}.fee_register").fetchone()["n"] == 3000


def test_the_role_can_write_only_the_generated_tables(conn, applied_fee, make_workspace):
    from qlens.perf.lab import ensure_lab

    ws_id = applied_fee.id
    ensure_lab(conn, ws_id)
    role = db.ws_role(ws_id)
    main, src, lab = (f"ws_{ws_id}", f"ws_{ws_id}_src", f"ws_{ws_id}_lab")
    for priv in ("INSERT", "UPDATE", "DELETE"):
        assert conn.execute("SELECT has_table_privilege(%s, %s, %s) AS ok",
                            (role, f"{main}.students", priv)).fetchone()["ok"]
        assert not conn.execute("SELECT has_table_privilege(%s, %s, %s) AS ok",
                                (role, f"{main}.original_sheet", priv)).fetchone()["ok"]
    for target in (f"{src}._staging", f"{src}._raw", f"{lab}.fee_register"):
        with _as_role(ws_id) as c:
            c.execute("SET TRANSACTION READ WRITE")
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                c.execute(sql.SQL("DELETE FROM {}").format(sql.Identifier(*target.split("."))))


def test_write_requires_login_and_ownership(client, second_client, conn, ws_id, other_applied_ws):
    body = {"sql": "DELETE FROM fee_register WHERE id = 1"}
    assert second_client.post(_url(ws_id, "/query/write"), json=body).status_code == 401
    assert client.post(_url(other_applied_ws.id, "/query/write"), json=body).status_code == 404
    other_user = {"email": "fixture2@example.com", "password": "fixture-password"}
    assert second_client.post("/api/auth/login", json=other_user).status_code == 200
    assert second_client.post(_url(ws_id, "/query/write"), json=body).status_code == 404
    assert conn.execute(f"SELECT count(*) AS n FROM ws_{ws_id}.fee_register").fetchone()["n"] == 3000


def test_key_values_reads_postgres_detail_lines():
    from qlens.data.sqlwrite import key_values

    assert key_values('Key (student_id)=(99999) is not present in table "students".') == {"student_id": "99999"}
    assert key_values('Key (id)=(3) is referenced from table "fee_register".') == {"id": "3"}
    assert key_values('Key (id)=(3) is still referenced from table "fee_register".') == {"id": "3"}
    assert key_values("Key (student_id, month)=(3, 2026-01) already exists.") == {"student_id": "3", "month": "2026-01"}
    assert key_values("Key (a, b)=(x, y, z) already exists.") == {}
    assert key_values("Failing row contains (1, null).") == {} and key_values(None) == {}
