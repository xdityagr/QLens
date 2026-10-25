import itertools
import random

import pytest

from qlens.analysis.cleanup import accept_all
from qlens.design import ddl
from qlens.design.proposal import build, live_proposal
from qlens.ingest.stage import import_dataset

FIXTURE_LOGIN = {"email": "fixture1@example.com", "password": "fixture-password"}


def columns(p):
    return {t.name: [c.name for c in t.columns] for t in p.tables}


def table(p, name):
    return next(t for t in p.tables if t.name == name)


def execute(conn, steps):
    """Run the generated SQL (as Task 11 will) and return the verify row."""
    verify = None
    for step in steps:
        cur = conn.execute(step.sql)
        if step.kind == "verify":
            verify = cur.fetchone()
    return verify


# ---- build ----------------------------------------------------------------------------------------

def test_fee_register_proposal(conn, fee_ws_clean):
    p = build(conn, fee_ws_clean.dataset_id)
    assert columns(p) == {
        "students": ["id", "student_name", "student_phone", "batch_id"], "batches": ["id", "batch", "teacher_id"],
        "teachers": ["id", "teacher", "teacher_phone"],
        "fee_register": ["id", "student_id", "month", "fee_paid", "payment_mode"]}
    fact = next(t for t in p.tables if t.kind == "fact")
    assert fact.unique_keys == [["student_id", "month"]] and fact.color_index == 3
    assert table(p, "students").unique_keys == [["student_name"], ["student_phone"]]
    assert table(p, "batches").unique_keys == [["batch"]]
    assert table(p, "teachers").unique_keys == [["teacher"], ["teacher_phone"]]
    assert [t.name for t in p.tables][-1] == "fee_register" and [t.color_index for t in p.tables] == [0, 1, 2, 3]
    assert p.status == "draft" and p.lossless_ok is None
    assert p.source_columns == ["student_name", "student_phone", "batch", "teacher", "teacher_phone", "month",
                                "fee_paid", "payment_mode"]


def test_fee_register_column_details(conn, fee_ws_clean):
    p = build(conn, fee_ws_clean.dataset_id)
    ids = {t.name: t.id for t in p.tables}
    students, fact = table(p, "students"), table(p, "fee_register")
    pk = students.columns[0]
    assert (pk.role, pk.data_type, pk.not_null, pk.references_table_id, pk.source_label) == ("pk", "bigint", True,
                                                                                             None, None)
    name = students.columns[1]
    assert (name.role, name.data_type, name.not_null, name.source_column, name.source_label) == (
        "attribute", "text", True, "student_name", "Student Name")
    batch_fk = students.columns[3]
    assert (batch_fk.role, batch_fk.data_type, batch_fk.references_table_id, batch_fk.source_column,
            batch_fk.source_label) == ("fk", "bigint", ids["batches"], None, "Batch")
    student_fk = fact.columns[1]
    assert student_fk.references_table_id == ids["students"] and student_fk.source_label == "Student Name"
    assert student_fk.not_null
    assert {c.name: c.data_type for c in fact.columns}["fee_paid"] == "bigint"
    assert table(p, "batches").columns[2].references_table_id == ids["teachers"]
    assert students.explanation == ("Each Student Name has one Student Phone and Batch, so they are stored once "
                                    "here instead of on every row.")
    assert table(p, "teachers").explanation == ("Each Teacher has one Teacher Phone, so they are stored once here "
                                                "instead of on every row.")
    assert fact.explanation == ("One row per original sheet row, identified by Student Name + Month. "
                                "It points to students instead of repeating their details.")


def test_build_supersedes_the_draft_and_is_deterministic(conn, fee_ws_clean):
    first = build(conn, fee_ws_clean.dataset_id)
    second = build(conn, fee_ws_clean.dataset_id)
    assert second.id != first.id and live_proposal(conn, fee_ws_clean.dataset_id).id == second.id
    status = conn.execute("SELECT status FROM qlens.schema_proposals WHERE id = %s", (first.id,)).fetchone()
    assert status["status"] == "superseded"

    def shape(p):
        return [(t.name, t.kind, t.color_index, t.explanation, t.unique_keys,
                 [(c.name, c.role, c.data_type, c.not_null, c.source_column) for c in t.columns]) for t in p.tables]

    assert shape(first) == shape(second)


def mark_applied(conn, proposal_id):
    """What Task 11 does after a lossless apply."""
    conn.execute("UPDATE qlens.schema_proposals SET status = 'applied', lossless_ok = true WHERE id = %s",
                 (proposal_id,))


def status_of(conn, proposal_id):
    return conn.execute("SELECT status FROM qlens.schema_proposals WHERE id = %s", (proposal_id,)).fetchone()["status"]


def test_build_keeps_the_applied_proposal(conn, fee_ws_clean):
    applied = build(conn, fee_ws_clean.dataset_id)
    mark_applied(conn, applied.id)
    draft = build(conn, fee_ws_clean.dataset_id)
    assert (status_of(conn, applied.id), draft.status) == ("applied", "draft")
    # The draft is what the user is editing, so it is the one shown.
    assert live_proposal(conn, fee_ws_clean.dataset_id).id == draft.id
    newer = build(conn, fee_ws_clean.dataset_id)
    assert [status_of(conn, i) for i in (applied.id, draft.id, newer.id)] == ["applied", "superseded", "draft"]


def test_applied_proposal_is_shown_when_there_is_no_draft(conn, fee_ws_clean):
    p = build(conn, fee_ws_clean.dataset_id)
    mark_applied(conn, p.id)
    shown = live_proposal(conn, fee_ws_clean.dataset_id)
    assert (shown.id, shown.status, shown.lossless_ok) == (p.id, "applied", True)


def test_hostel_and_kirana_proposals(conn, hostel_ws, kirana_ws):
    accept_all(conn, hostel_ws.dataset_id)
    accept_all(conn, kirana_ws.dataset_id)
    hostel, kirana = build(conn, hostel_ws.dataset_id), build(conn, kirana_ws.dataset_id)
    assert columns(hostel) == {
        "rooms": ["id", "room", "hostel_block_id"], "students": ["id", "room_id", "student"],
        "hostel_blocks": ["id", "hostel_block", "warden"], "date_meals": ["id", "date", "meal", "menu_item"],
        "hostel_mess": ["id", "student_id", "date_meal_id", "attended"]}
    assert table(hostel, "hostel_mess").unique_keys == [["student_id", "date_meal_id"]]
    assert table(hostel, "date_meals").unique_keys == [["date", "meal"]]
    assert columns(kirana) == {
        "bills": ["id", "bill_no", "date", "customer_id"], "customers": ["id", "customer", "customer_phone"],
        "items": ["id", "item", "category", "unit_price"],
        "kirana_sales": ["id", "bill_id", "item_id", "qty", "amount"]}


# ---- generated SQL --------------------------------------------------------------------------------

def test_sql_text_is_quoted(conn, fee_ws_clean):
    p = build(conn, fee_ws_clean.dataset_id)
    steps = ddl.render(p, fee_ws_clean.id)
    assert [s.kind for s in steps] == ["schema", "table", "table", "table", "table",
                                       "insert", "insert", "insert", "insert", "view", "verify"]
    # Referenced tables are created and loaded before the tables that point at them.
    created = [s.title.split()[-1] for s in steps if s.kind == "table"]
    assert created == ["teachers", "batches", "students", "fee_register"]
    text = ddl.as_text(steps, conn)
    ws = f"ws_{fee_ws_clean.id}"
    assert f"CREATE TABLE {ws}." in text and "UNIQUE NULLS NOT DISTINCT" in text
    assert f"CREATE TABLE {ws}.students (" in text
    assert "CONSTRAINT students_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES " \
           f"{ws}.batches (id) ON DELETE RESTRICT" in text
    assert "CONSTRAINT students_student_name_key UNIQUE NULLS NOT DISTINCT (student_name)" in text
    assert f"FROM {ws}_src._staging s" in text and "ORDER BY s._row_id" in text
    # Key columns without NULLs are matched with `=` (hash-joinable), see the NULL test below.
    assert f"LEFT JOIN {ws}.students ON students.student_name = s.student_name" in text
    assert f"CREATE VIEW {ws}.original_sheet AS" in text and "EXCEPT ALL" in text
    assert text.count("\n-- ") + text.startswith("-- ") == len(steps)
    assert '"' not in text                         # nothing here needs quoting


def test_generated_sql_rebuilds_the_sheet(conn, fee_ws_clean):
    p = build(conn, fee_ws_clean.dataset_id)
    v = execute(conn, ddl.render(p, fee_ws_clean.id))
    assert v == {"staging_rows": 3000, "reconstructed_rows": 3000, "extra_rows": 0, "missing_rows": 0}
    ws = f"ws_{fee_ws_clean.id}"
    assert conn.execute(f"SELECT count(*) AS n FROM {ws}.teachers").fetchone()["n"] == 6
    assert conn.execute(f"SELECT count(*) AS n FROM {ws}.students").fetchone()["n"] == 300
    cols = [r["column_name"] for r in conn.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = %s AND table_name = "
        "'original_sheet' ORDER BY ordinal_position", (ws,))]
    assert cols == p.source_columns


@pytest.mark.parametrize("csv_", [
    # Reserved words and a quote in the headers (Order, Group, User's Name).
    b"Order,Group,User's Name,Amount\n1,A,Asha,10\n2,A,Asha,20\n3,B,Ravi,5\n4,B,Ravi,7\n",
    # A determinant that is empty on some rows: the NULL teacher becomes one row of its table.
    b"Student,Teacher,Phone\nA,T1,111\nB,T1,111\nC,,\nD,,\nE,T2,222\nF,T2,222\n",
])
def test_generated_sql_is_lossless_for_awkward_sheets(conn, workspace, csv_):
    ds = import_dataset(conn, workspace, "awkward.csv", csv_, source="upload")
    accept_all(conn, ds.id)
    p = build(conn, ds.id)
    assert len(p.tables) > 1
    v = execute(conn, ddl.render(p, workspace))
    assert v["extra_rows"] == v["missing_rows"] == 0 and v["staging_rows"] == v["reconstructed_rows"]


def test_empty_determinant_is_one_row(conn, workspace):
    ds = import_dataset(conn, workspace, "awkward.csv",
                        b"Student,Teacher,Phone\nA,T1,111\nB,T1,111\nC,,\nD,,\nE,T2,222\nF,T2,222\n",
                        source="upload")
    accept_all(conn, ds.id)
    p = build(conn, ds.id)
    assert columns(p) == {"teachers": ["id", "teacher", "phone"], "awkward": ["id", "student", "teacher_id"]}
    assert not table(p, "awkward").columns[2].not_null
    steps = ddl.render(p, workspace)
    assert "teachers.teacher IS NOT DISTINCT FROM s.teacher" in ddl.as_text(steps, conn)
    execute(conn, steps)
    rows = conn.execute(f"SELECT teacher FROM ws_{workspace}.teachers ORDER BY teacher").fetchall()
    assert [r["teacher"] for r in rows] == ["T1", "T2", None]
    assert conn.execute(f"SELECT count(*) AS n FROM ws_{workspace}.awkward WHERE teacher_id IS NULL"
                        ).fetchone()["n"] == 0


def test_view_joins_a_table_no_foreign_key_reaches(conn, workspace):
    # acct -> branch, dept -> city, (branch, city) -> rate: no relation holds both branch and city, so no
    # foreign key leads to branch_cities; the view joins it on its natural key instead.
    lines = ["acct,branch,dept,city,rate"]
    for a, d in itertools.product(range(9), range(6)):
        lines.append(f"a{a},b{a % 3},d{d},c{d % 2},r{a % 3}{d % 2}")
    ds = import_dataset(conn, workspace, "x.csv", "\n".join(lines).encode(), source="upload")
    accept_all(conn, ds.id)
    p = build(conn, ds.id)
    assert columns(p) == {"accts": ["id", "acct", "branch"], "depts": ["id", "dept", "city"],
                          "branch_cities": ["id", "branch", "city", "rate"], "x": ["id", "acct_id", "dept_id"]}
    steps = ddl.render(p, workspace)
    assert ("LEFT JOIN ws_{0}.branch_cities ON branch_cities.branch = accts.branch "
            "AND branch_cities.city = depts.city").format(workspace) in ddl.as_text(steps, conn)
    v = execute(conn, steps)
    assert v == {"staging_rows": 54, "reconstructed_rows": 54, "extra_rows": 0, "missing_rows": 0}


def test_reserved_identifiers_are_quoted_in_text(conn, workspace):
    ds = import_dataset(conn, workspace, "orders.csv",
                        b"Order,Group,User\n1,A,x\n2,A,x\n3,B,y\n4,B,y\n", source="upload")
    accept_all(conn, ds.id)
    text = ddl.as_text(ddl.render(build(conn, ds.id), workspace), conn)
    assert '"group"' in text and '"order"' in text and " group " not in text


def _generated_sheet(seed: int) -> bytes:
    """A small sheet whose columns are random functions of earlier columns (one or two of them), with
    blank cells, numeric and text values, reserved-word headers and some fully repeated rows."""
    rnd = random.Random(seed)
    n_cols, n_rows = rnd.randint(2, 7), rnd.randint(6, 60)
    specs = []
    for i in range(n_cols):
        kind = rnd.random()
        sources = ((rnd.randrange(i),) if i >= 1 and kind < 0.35
                   else tuple(sorted(rnd.sample(range(i), 2))) if i >= 2 and kind < 0.55 else None)
        specs.append({"sources": sources, "values": rnd.randint(1, 6), "numeric": rnd.random() < 0.3,
                      "blank": rnd.choice([0, 0, 0.1, 0.3]), "mapping": {}})
    rows = []
    for _ in range(n_rows):
        row = []
        for c in specs:
            if c["sources"] is None:
                v = None if rnd.random() < c["blank"] else rnd.randint(0, rnd.choice([2, 5, 30]))
            else:
                k = tuple(row[i] for i in c["sources"])
                if k not in c["mapping"]:
                    c["mapping"][k] = None if rnd.random() < c["blank"] else rnd.randint(0, c["values"])
                v = c["mapping"][k]
            row.append(v)
        rows.append(row)
    if rnd.random() < 0.3:
        rows += rnd.sample(rows, min(3, len(rows)))
    header = [rnd.choice(["c", "order", "Group", "x_name", "y_id"]) + str(i) for i in range(len(specs))]
    cells = [["" if v is None else str(v) if c["numeric"] else f"v{v}" for c, v in zip(specs, row)]
             for row in rows]
    return "\n".join(",".join(r) for r in [header, *cells]).encode() + b"\n"


# Seeds whose sheets decompose into 2-4 tables: chains of foreign keys, composite natural keys, a fact
# with and without a natural key, and a table only reachable through its natural key. (A 400-seed run
# of the same generator was lossless throughout.)
@pytest.mark.parametrize("seed", [0, 5, 11, 17, 19, 26, 29, 33, 35])
def test_generated_sql_is_lossless_for_generated_sheets(conn, workspace, seed):
    ds = import_dataset(conn, workspace, "gen.csv", _generated_sheet(seed), source="upload")
    accept_all(conn, ds.id)
    p = build(conn, ds.id)
    assert len(p.tables) > 1
    v = execute(conn, ddl.render(p, workspace))
    assert v["extra_rows"] == v["missing_rows"] == 0 and v["staging_rows"] == v["reconstructed_rows"]


def test_hostel_and_kirana_sql_is_lossless(conn, hostel_ws, kirana_ws):
    for ws in (hostel_ws, kirana_ws):
        accept_all(conn, ws.dataset_id)
        v = execute(conn, ddl.render(build(conn, ws.dataset_id), ws.id))
        assert v["extra_rows"] == v["missing_rows"] == 0 and v["staging_rows"] == v["reconstructed_rows"] > 0


def test_render_follows_renames(conn, fee_ws_clean):
    p = build(conn, fee_ws_clean.dataset_id)
    students = table(p, "students")
    conn.execute("UPDATE qlens.proposed_tables SET name = 'learners' WHERE id = %s", (students.id,))
    conn.execute("UPDATE qlens.proposed_columns SET name = 'full_name' WHERE id = %s", (students.columns[1].id,))
    conn.execute("UPDATE qlens.proposed_columns SET name = 'learner_id' WHERE id = %s",
                 (table(p, "fee_register").columns[1].id,))
    p = live_proposal(conn, fee_ws_clean.dataset_id)
    assert table(p, "learners").unique_keys == [["full_name"], ["student_phone"]]
    v = execute(conn, ddl.render(p, fee_ws_clean.id))
    assert v["extra_rows"] == v["missing_rows"] == 0
    ws = f"ws_{fee_ws_clean.id}"
    assert conn.execute(f"SELECT count(DISTINCT learner_id) AS n FROM {ws}.fee_register").fetchone()["n"] == 300


# ---- routes ---------------------------------------------------------------------------------------

def test_proposal_routes(client, fee_ws_clean):
    client.post("/api/auth/login", json=FIXTURE_LOGIN)
    base = f"/api/workspaces/{fee_ws_clean.id}/proposal"
    r = client.get(base)
    assert r.status_code == 404 and r.json()["error"]["code"] == "no_proposal"
    made = client.post(base)
    assert made.status_code == 200
    body = made.json()
    assert set(body) >= {"id", "status", "lossless_ok", "tables"}
    assert set(body["tables"][0]) >= {"id", "name", "kind", "color_index", "explanation", "columns", "unique_keys"}
    assert set(body["tables"][0]["columns"][0]) >= {"id", "name", "data_type", "role", "not_null",
                                                    "references_table_id", "source_label"}
    assert client.get(base).json() == body
    sql_text = client.get(f"{base}/sql").json()["sql"]
    assert f"CREATE TABLE ws_{fee_ws_clean.id}.students (" in sql_text


def test_rename_validation(client, fee_ws_clean):
    client.post("/api/auth/login", json=FIXTURE_LOGIN)
    base = f"/api/workspaces/{fee_ws_clean.id}/proposal"
    p = client.post(base).json()
    students = next(t for t in p["tables"] if t["name"] == "students")
    url = f"{base}/tables/{students['id']}"

    for bad in ("Bad Name", "_staging", "1st", "a" * 64):
        r = client.patch(url, json={"name": bad})
        assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_identifier", bad
    for taken in ("teachers", "original_sheet"):
        r = client.patch(url, json={"name": taken})
        assert r.status_code == 409 and r.json()["error"]["code"] == "name_taken", taken
    r = client.patch(url, json={"name": "learners"})
    assert r.status_code == 200
    assert "learners" in [t["name"] for t in r.json()["tables"]]
    assert f"CREATE TABLE ws_{fee_ws_clean.id}.learners (" in client.get(f"{base}/sql").json()["sql"]

    col = students["columns"][1]
    col_url = f"{base}/columns/{col['id']}"
    assert client.patch(col_url, json={"name": "Full Name"}).json()["error"]["code"] == "invalid_identifier"
    r = client.patch(col_url, json={"name": "student_phone"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "name_taken"
    r = client.patch(col_url, json={"name": "full_name"})
    assert r.status_code == 200
    learners = next(t for t in r.json()["tables"] if t["name"] == "learners")
    assert learners["columns"][1]["name"] == "full_name" and learners["unique_keys"][0] == ["full_name"]

    assert client.patch(f"{base}/tables/999999", json={"name": "x"}).status_code == 404
    assert client.patch(f"{base}/columns/999999", json={"name": "x"}).status_code == 404


def test_explanations_follow_renames(client, fee_ws_clean):
    client.post("/api/auth/login", json=FIXTURE_LOGIN)
    base = f"/api/workspaces/{fee_ws_clean.id}/proposal"
    p = client.post(base).json()
    students = next(t for t in p["tables"] if t["name"] == "students")
    p = client.patch(f"{base}/tables/{students['id']}", json={"name": "learners"}).json()
    fact = next(t for t in p["tables"] if t["kind"] == "fact")
    assert fact["explanation"] == ("One row per original sheet row, identified by Student Name + Month. "
                                   "It points to learners instead of repeating their details.")
    assert client.get(base).json()["tables"] == p["tables"]


def test_renames_only_on_a_draft(client, conn, fee_ws_clean):
    client.post("/api/auth/login", json=FIXTURE_LOGIN)
    base = f"/api/workspaces/{fee_ws_clean.id}/proposal"
    first = client.post(base).json()
    conn.execute("UPDATE qlens.schema_proposals SET status = 'applied', lossless_ok = true WHERE id = %s",
                 (first["id"],))
    conn.commit()
    table_url = f"{base}/tables/{first['tables'][0]['id']}"
    column_url = f"{base}/columns/{first['tables'][0]['columns'][1]['id']}"
    for url in (table_url, column_url):
        r = client.patch(url, json={"name": "renamed"})
        assert r.status_code == 409 and r.json()["error"]["code"] == "proposal_not_draft", url
    second = client.post(base).json()                 # a draft next to the applied one
    client.post(base)                                 # supersedes `second`
    r = client.patch(f"{base}/tables/{second['tables'][0]['id']}", json={"name": "renamed"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "proposal_not_draft"


def test_rejected_fd_changes_design(client, fee_ws_clean):
    client.post("/api/auth/login", json=FIXTURE_LOGIN)
    base = f"/api/workspaces/{fee_ws_clean.id}"
    fds = client.get(f"{base}/analysis").json()["fds"]

    def reject(lhs, rhs):
        fd = next(f for f in fds if f["lhs"] == lhs and f["rhs"] == rhs)
        assert client.patch(f"{base}/fds/{fd['id']}", json={"accepted": False}).status_code == 200

    # The design is built from the accepted, non-derived dependencies (the list shown by default).
    # Rejecting batch -> teacher makes batch -> teacher_phone (derived until now) part of that list, and
    # with teacher_phone -> teacher it still gives every batch one teacher: batches stays, and the user
    # sees the dependency that keeps it.
    reject(["batch"], "teacher")
    shown = {(tuple(f["lhs"]), f["rhs"]) for f in client.get(f"{base}/analysis").json()["fds"]
             if f["is_exact"] and f["accepted"] and not f["is_derived"]}
    assert (("batch",), "teacher_phone") in shown and (("batch",), "teacher") not in shown
    p = client.post(f"{base}/proposal").json()
    assert {t["name"]: [c["name"] for c in t["columns"]] for t in p["tables"]}["batches"] == [
        "id", "batch", "teacher_id"]

    # Once batch determines neither, batches disappears and the teacher hangs off the student instead
    # (student -> teacher now survives the minimal cover).
    reject(["batch"], "teacher_phone")
    p = client.post(f"{base}/proposal").json()
    cols = {t["name"]: [c["name"] for c in t["columns"]] for t in p["tables"]}
    assert "batches" not in cols
    assert cols["students"] == ["id", "student_name", "student_phone", "batch", "teacher_id"]
    assert cols["teachers"] == ["id", "teacher", "teacher_phone"]


def test_proposal_routes_guard(client, second_client, fee_ws_clean):
    base = f"/api/workspaces/{fee_ws_clean.id}/proposal"
    assert second_client.post(base).status_code == 401
    second_client.post("/api/auth/signup", json={"email": "o@x.com", "password": "another pass",
                                                  "display_name": "O"})
    assert second_client.post(base).status_code == 404
    client.post("/api/auth/login", json=FIXTURE_LOGIN)
    t = client.post(base).json()["tables"][0]
    mine = second_client.post("/api/workspaces", json={"name": "Mine"}).json()["id"]
    r = second_client.post(f"/api/workspaces/{mine}/proposal")
    assert r.status_code == 404 and r.json()["error"]["code"] == "no_dataset"
    second_client.post(f"/api/workspaces/{mine}/dataset/sample", json={"name": "fee_register"})
    r = second_client.post(f"/api/workspaces/{mine}/proposal")
    assert r.status_code == 409 and r.json()["error"]["code"] == "not_analyzed"
    second_client.post(f"/api/workspaces/{mine}/analyze")
    second_client.post(f"/api/workspaces/{mine}/proposal")
    # A table id from another workspace's proposal is invisible.
    r = second_client.patch(f"/api/workspaces/{mine}/proposal/tables/{t['id']}", json={"name": "x"})
    assert r.status_code == 404 and r.json()["error"]["code"] == "table_not_found"
