"""The assistant: a scripted fake model drives the real tools against real workspaces (no network)."""
import os

import pytest

from qlens.assistant.llm import ChatModel, FunctionCall, ModelError, ModelStep, ToolSpec, Turn
from qlens.assistant.routes import chat_model
from qlens.config import get_settings
from qlens.design.proposal import build, live_proposal
from qlens.main import app

FIXTURE_USER = {"email": "fixture1@example.com", "password": "fixture-password"}


class FakeModel:
    """Plays a script: each entry is a ModelStep, or a function of the turns so far that returns one."""
    name = "fake"

    def __init__(self, *script):
        self.script = list(script)
        self.seen: list[tuple[str, list[Turn], list[ToolSpec]]] = []

    def step(self, system, history, tools):
        self.seen.append((system, list(history), list(tools)))
        entry = self.script.pop(0)
        return entry(history) if callable(entry) else entry


def call(name, **args) -> ModelStep:
    return ModelStep(text=None, calls=[FunctionCall(name=name, args=args, id=f"c-{name}")])


def say(text) -> ModelStep:
    return ModelStep(text=text, calls=[])


@pytest.fixture(autouse=True)
def _no_real_key(monkeypatch):
    # backend/.env holds a real key: no test except the opt-in live one may reach Gemini.
    if os.environ.get("QLENS_LIVE_LLM") != "1":
        monkeypatch.setattr(get_settings(), "gemini_api_key", None)


@pytest.fixture
def use_model(client):
    def install(model: ChatModel) -> ChatModel:
        app.dependency_overrides[chat_model] = lambda: model
        return model
    return install


def login(client):
    assert client.post("/api/auth/login", json=FIXTURE_USER).status_code == 200


def ask(client, ws_id, message, status=200, **extra):
    r = client.post(f"/api/workspaces/{ws_id}/assistant", json={"message": message, **extra})
    assert r.status_code == status, r.text
    return r.json()


def table_names(p) -> list[str]:
    return [t["name"] if isinstance(t, dict) else t.name for t in (p["tables"] if isinstance(p, dict) else p.tables)]


def last_tool_response(history: list[Turn]) -> dict:
    return history[-1].results[-1].response


@pytest.fixture
def draft_ws(conn, client, fee_ws_clean):
    build(conn, fee_ws_clean.dataset_id)
    conn.commit()
    login(client)
    return fee_ws_clean


# ---- questions ------------------------------------------------------------------------------------

def test_question_checks_dependency_and_answers(client, conn, draft_ws, use_model):
    seen = {}

    def answer(history):
        seen.update(last_tool_response(history))
        return say("Yes: every batch has exactly one teacher (0 rows break it).")

    model = use_model(FakeModel(call("check_dependency", lhs=["batch"], rhs="teacher"), answer))
    body = ask(client, draft_ws.id, "Does batch decide the teacher?")
    assert body["intent"] == "answer" and body["proposal"] is None and body["sql_runs"] == []
    assert body["reply"].startswith("Yes")
    assert body["actions"] == [{"tool": "check_dependency", "args": {"lhs": ["batch"], "rhs": "teacher"}, "ok": True,
                                "summary": "Checked batch → teacher: holds in every row"}]
    result = seen["result"]
    assert result["exact"] is True and result["violating_rows"] == 0 and result["examples"] == []
    assert result["stored"] == {"accepted": True, "derived": False, "used_in_design": True}
    # The system prompt carries the workspace summary and the tools offered on the design screen.
    system, _, tools = model.seen[0]
    assert "Draft design tables: students, batches, teachers, fee_register." in system
    assert {"rename_table", "undo_last_edit", "run_sql", "check_dependency"} <= {t.name for t in tools}

    [row] = conn.execute("SELECT t.tool, t.args, t.ok, t.error, t.result->>'exact' AS exact, m.role, m.intent "
                         "FROM qlens.assistant_tool_calls t JOIN qlens.assistant_messages m ON m.id = t.message_id"
                         ).fetchall()
    assert (row["tool"], row["args"], row["ok"], row["error"], row["exact"], row["role"], row["intent"]) == (
        "check_dependency", {"lhs": ["batch"], "rhs": "teacher"}, True, None, "true", "assistant", "answer")


def test_check_dependency_reports_a_broken_one_with_examples(client, fee_ws, use_model):
    """Before cleanup the fee register has a mistyped phone, so teacher -> teacher_phone is broken in a few rows."""
    login(client)
    seen = {}

    def answer(history):
        seen.update(last_tool_response(history))
        return say("Not quite.")

    use_model(FakeModel(call("check_dependency", lhs=["Teacher"], rhs="Teacher Phone"), answer))
    body = ask(client, fee_ws.id, "does a teacher have one phone?")
    r = seen["result"]
    assert (r["lhs"], r["rhs"]) == (["teacher"], "teacher_phone")     # headers resolve to column names
    assert r["exact"] is False and r["violating_rows"] > 0 and 1 <= len(r["examples"]) <= 5
    assert all(len(e["rhs_values"]) >= 2 for e in r["examples"])
    assert "broken in" in body["actions"][0]["summary"]


def test_unknown_column_is_a_tool_error(client, draft_ws, use_model):
    seen = {}

    def answer(history):
        seen.update(last_tool_response(history))
        return say("There is no such column.")

    use_model(FakeModel(call("check_dependency", lhs=["shoe_size"], rhs="teacher"), answer))
    body = ask(client, draft_ws.id, "does shoe size decide teacher?")
    assert body["actions"][0]["ok"] is False and body["intent"] == "answer"
    assert seen["error"]["code"] == "unknown_column" and "student_name" in seen["error"]["message"]


# ---- edits ----------------------------------------------------------------------------------------

def test_rename_table_edits_a_new_draft_version(client, conn, draft_ws, use_model):
    before = live_proposal(conn, draft_ws.dataset_id)
    use_model(FakeModel(call("rename_table", table="students", new_name="learners"),
                        say("Renamed `students` to `learners`.")))
    body = ask(client, draft_ws.id, "rename students to learners")
    assert body["intent"] == "edit" and body["actions"][0]["ok"] is True
    assert body["actions"][0]["summary"] == "Renamed table students to learners"
    assert table_names(body["proposal"]) == ["learners", "batches", "teachers", "fee_register"]
    assert body["proposal"]["status"] == "draft"
    conn.rollback()
    after = live_proposal(conn, draft_ws.dataset_id)
    assert after.id == body["proposal"]["id"] != before.id
    assert table_names(after) == ["learners", "batches", "teachers", "fee_register"]
    # The version the user was looking at is kept, unchanged, as history; the new draft points back at it.
    old = conn.execute("SELECT status FROM qlens.schema_proposals WHERE id = %s", (before.id,)).fetchone()
    assert old["status"] == "superseded"
    assert conn.execute("SELECT based_on_id FROM qlens.schema_proposals WHERE id = %s",
                        (after.id,)).fetchone()["based_on_id"] == before.id
    names = [r["name"] for r in conn.execute("SELECT name FROM qlens.proposed_tables WHERE proposal_id = %s "
                                             "ORDER BY ordinal", (before.id,))]
    assert names == ["students", "batches", "teachers", "fee_register"]
    # The copy kept the keys and foreign keys (the fact still points at the renamed table).
    fact = next(t for t in after.tables if t.name == "fee_register")
    learners = next(t for t in after.tables if t.name == "learners")
    assert fact.unique_keys == [["student_id", "month"]]
    assert fact.columns[1].references_table_id == learners.id
    assert learners.unique_keys == [["student_name"], ["student_phone"]]


def test_two_edits_in_one_message_are_one_version(client, conn, draft_ws, use_model):
    before = live_proposal(conn, draft_ws.dataset_id)
    use_model(FakeModel(ModelStep(text=None, calls=[
        FunctionCall("rename_table", {"table": "students", "new_name": "learners"}),
        FunctionCall("rename_column", {"table": "learners", "column": "student_phone", "new_name": "phone"})]),
        say("Done.")))
    body = ask(client, draft_ws.id, "call students learners and their phone just phone")
    assert [a["ok"] for a in body["actions"]] == [True, True]
    learners = body["proposal"]["tables"][0]
    assert [c["name"] for c in learners["columns"]] == ["id", "student_name", "phone", "batch_id"]
    conn.rollback()
    based_on = conn.execute("SELECT based_on_id FROM qlens.schema_proposals WHERE id = %s",
                            (body["proposal"]["id"],)).fetchone()["based_on_id"]
    assert based_on == before.id
    assert conn.execute("SELECT count(*) AS n FROM qlens.schema_proposals").fetchone()["n"] == 2


def test_invalid_rename_is_reported_to_the_model_and_changes_nothing(client, conn, draft_ws, use_model):
    before = live_proposal(conn, draft_ws.dataset_id)
    seen = {}

    def explain(history):
        seen.update(last_tool_response(history))
        return say("Table names must be lower-case with underscores, like `bad_name`.")

    use_model(FakeModel(call("rename_table", table="students", new_name="Bad Name"), explain))
    body = ask(client, draft_ws.id, "rename students to Bad Name")
    assert body["intent"] == "answer" and body["proposal"] is None
    assert body["actions"][0]["ok"] is False and "lower-case" in body["actions"][0]["summary"]
    assert seen["error"]["code"] == "invalid_identifier"
    conn.rollback()
    after = live_proposal(conn, draft_ws.dataset_id)
    # The failed edit's savepoint took the version copy with it.
    assert after.id == before.id and table_names(after) == table_names(before)
    assert conn.execute("SELECT count(*) AS n FROM qlens.schema_proposals").fetchone()["n"] == 1
    row = conn.execute("SELECT ok, error, result FROM qlens.assistant_tool_calls").fetchone()
    assert row["ok"] is False and "lower-case" in row["error"] and row["result"] == {"code": "invalid_identifier"}


@pytest.mark.parametrize("args,code", [
    ({"table": "nope", "new_name": "x"}, "unknown_table"),
    ({"table": "students", "new_name": "batches"}, "name_taken"),
    ({"table": "students"}, "invalid_arguments"),
    ({"table": "students", "new_name": "x", "extra": 1}, "invalid_arguments"),
])
def test_rename_errors(client, draft_ws, use_model, args, code):
    seen = {}

    def explain(history):
        seen.update(last_tool_response(history))
        return say("Could not do that.")

    use_model(FakeModel(call("rename_table", **args), explain))
    body = ask(client, draft_ws.id, "rename")
    assert body["actions"][0]["ok"] is False and seen["error"]["code"] == code


def test_renaming_the_primary_key_is_reported_to_the_model(client, conn, draft_ws, use_model):
    seen = {}

    def explain(history):
        seen.update(last_tool_response(history))
        return say("The id column keeps its name.")

    use_model(FakeModel(call("rename_column", table="students", column="id", new_name="student_id"), explain))
    body = ask(client, draft_ws.id, "rename students.id to student_id")
    assert body["intent"] == "answer" and body["actions"][0]["ok"] is False
    assert seen["error"]["code"] == "pk_rename_not_allowed"
    assert "surrogate primary key" in seen["error"]["message"]
    conn.rollback()
    students = next(t for t in live_proposal(conn, draft_ws.dataset_id).tables if t.name == "students")
    assert students.columns[0].name == "id"


FD_ACCEPTED = ("SELECT f.accepted FROM qlens.functional_dependencies f "
               "JOIN qlens.dataset_columns r ON r.id = f.rhs_column_id "
               "JOIN qlens.fd_lhs_columns l ON l.fd_id = f.id JOIN qlens.dataset_columns lc ON lc.id = l.column_id "
               "WHERE r.name = 'teacher' AND lc.name = 'batch' AND f.lhs_size = 1")


def test_unaccepting_a_dependency_rebuilds_and_undo_restores(client, conn, draft_ws, use_model):
    use_model(FakeModel(call("rename_table", table="students", new_name="learners"), say("Renamed.")))
    first = ask(client, draft_ws.id, "rename students to learners")
    seen = {}

    def explain(history):
        seen.update(last_tool_response(history))
        return say("The design still links them through the teacher's phone.")

    use_model(FakeModel(call("set_dependency_accepted", lhs=["batch"], rhs="teacher", accepted=False), explain))
    body = ask(client, draft_ws.id, "batch doesn't really decide teacher", conversation_id=first["conversation_id"])
    assert body["intent"] == "edit"
    assert body["actions"][0]["summary"] == "Stopped using batch → teacher and rebuilt the design"
    # Pinned: batch -> teacher_phone was derived; without batch -> teacher it joins the cover, and since
    # teacher_phone is a key of teachers (teacher_phone -> teacher), batches still points at teachers. The
    # tables are the same, only the earlier rename is gone (a rebuild synthesizes from scratch), and the
    # tool tells the model why nothing moved.
    shapes = {t["name"]: [c["name"] for c in t["columns"]] for t in body["proposal"]["tables"]}
    assert shapes == {"students": ["id", "student_name", "student_phone", "batch_id"],
                      "batches": ["id", "batch", "teacher_id"], "teachers": ["id", "teacher", "teacher_phone"],
                      "fee_register": ["id", "student_id", "month", "fee_paid", "payment_mode"]}
    implied = seen["result"]["still_implied_by"]
    assert {"lhs": ["batch"], "rhs": "teacher_phone"} in implied
    assert {"lhs": ["teacher_phone"], "rhs": "teacher"} in implied
    conn.rollback()
    assert conn.execute(FD_ACCEPTED).fetchone()["accepted"] is False

    use_model(FakeModel(call("undo_last_edit"), say("Back to how it was.")))
    undone = ask(client, draft_ws.id, "undo that", conversation_id=first["conversation_id"])
    assert undone["intent"] == "edit"
    assert table_names(undone["proposal"]) == ["learners", "batches", "teachers", "fee_register"]
    conn.rollback()
    assert conn.execute(FD_ACCEPTED).fetchone()["accepted"] is True   # undo brings the dependency back
    use_model(FakeModel(call("undo_last_edit"), say("Undone again.")))
    twice = ask(client, draft_ws.id, "and undo the rename too", conversation_id=first["conversation_id"])
    assert table_names(twice["proposal"]) == ["students", "batches", "teachers", "fee_register"]
    seen.clear()

    def nothing(history):
        seen.update(last_tool_response(history))
        return say("Nothing left to undo.")

    use_model(FakeModel(call("undo_last_edit"), nothing))
    last = ask(client, draft_ws.id, "undo", conversation_id=first["conversation_id"])
    assert last["intent"] == "answer" and seen["error"]["code"] == "nothing_to_undo"


def test_unknown_dependency_is_a_tool_error(client, draft_ws, use_model):
    seen = {}

    def explain(history):
        seen.update(last_tool_response(history))
        return say("That dependency was not found.")

    use_model(FakeModel(call("set_dependency_accepted", lhs=["fee_paid"], rhs="teacher", accepted=False), explain))
    body = ask(client, draft_ws.id, "fee paid does not decide teacher")
    assert body["intent"] == "answer" and seen["error"]["code"] == "unknown_dependency"


def test_rebuild_design_drops_renames(client, draft_ws, use_model):
    use_model(FakeModel(call("rename_table", table="students", new_name="learners"),
                        call("rebuild_design"), say("Rebuilt.")))
    body = ask(client, draft_ws.id, "rename then rebuild")
    assert table_names(body["proposal"]) == ["students", "batches", "teachers", "fee_register"]


def test_rebuild_after_a_flip_in_the_same_message_keeps_the_flip_for_undo(client, conn, draft_ws, use_model):
    use_model(FakeModel(call("set_dependency_accepted", lhs=["batch"], rhs="teacher", accepted=False),
                        call("rebuild_design"), say("Rebuilt.")))
    ask(client, draft_ws.id, "stop using batch -> teacher, then rebuild")
    conn.rollback()
    assert conn.execute(FD_ACCEPTED).fetchone()["accepted"] is False
    draft = conn.execute("SELECT fd_changes FROM qlens.schema_proposals WHERE dataset_id = %s AND status = 'draft'",
                         (draft_ws.dataset_id,)).fetchone()
    assert list(draft["fd_changes"].values()) == [True]
    assert client.post(f"/api/workspaces/{draft_ws.id}/assistant/undo").status_code == 200
    conn.rollback()
    assert conn.execute(FD_ACCEPTED).fetchone()["accepted"] is True


def test_edit_on_applied_only_workspace_copies_the_applied_design(client, conn, applied_fee, use_model):
    login(client)
    applied = live_proposal(conn, applied_fee.dataset_id)
    assert applied.status == "applied"
    use_model(FakeModel(call("rename_table", table="students", new_name="learners"), say("Renamed.")))
    body = ask(client, applied_fee.id, "rename students to learners")
    assert body["proposal"]["status"] == "draft" and body["proposal"]["id"] != applied.id
    assert table_names(body["proposal"]) == ["learners", "batches", "teachers", "fee_register"]
    conn.rollback()
    rows = conn.execute("SELECT id, status, based_on_id FROM qlens.schema_proposals ORDER BY id").fetchall()
    assert [(r["id"], r["status"]) for r in rows] == [(applied.id, "applied"), (body["proposal"]["id"], "draft")]
    assert rows[1]["based_on_id"] == applied.id
    names = [r["name"] for r in conn.execute("SELECT name FROM qlens.proposed_tables WHERE proposal_id = %s "
                                             "ORDER BY ordinal", (applied.id,))]
    assert names == ["students", "batches", "teachers", "fee_register"]


# ---- run_sql and explain_query --------------------------------------------------------------------

def test_run_sql_refuses_a_delete(client, conn, applied_fee, use_model):
    login(client)
    seen = {}

    def explain(history):
        seen.update(last_tool_response(history))
        return say("I can only read data.")

    use_model(FakeModel(call("run_sql", sql="DELETE FROM students"), explain))
    body = ask(client, applied_fee.id, "delete all students")
    assert body["actions"][0]["ok"] is False and seen["error"]["code"] == "not_a_select"
    assert body["sql_runs"] == []
    conn.rollback()
    assert conn.execute(f"SELECT count(*) AS n FROM ws_{applied_fee.id}.students").fetchone()["n"] == 300
    run = conn.execute("SELECT id, source, status, sql_text FROM qlens.query_runs").fetchone()
    assert (run["source"], run["status"], run["sql_text"]) == ("english", "error", "DELETE FROM students")
    tc = conn.execute("SELECT query_run_id, ok FROM qlens.assistant_tool_calls").fetchone()
    assert (tc["query_run_id"], tc["ok"]) == (run["id"], False)


def test_run_sql_answers_from_the_data(client, conn, applied_fee, use_model):
    login(client)
    seen = {}

    def answer(history):
        seen.update(last_tool_response(history))
        return say(f"There are {seen['result']['rows'][0][0]} students.")

    use_model(FakeModel(call("run_sql", sql="SELECT count(*) AS n FROM students;"), answer))
    body = ask(client, applied_fee.id, "how many students are there?", context="query")
    assert body["reply"] == "There are 300 students." and body["intent"] == "answer"
    assert body["sql_runs"] == [{"sql": "SELECT count(*) AS n FROM students", "row_count": 1,
                                 "columns": [{"name": "n", "type": "bigint"}], "rows": [[300]]}]
    assert seen["result"] == {"columns": ["n"], "rows": [[300]], "row_count": 1, "truncated": False}
    conn.rollback()
    run = conn.execute("SELECT id, source, status FROM qlens.query_runs").fetchone()
    assert (run["source"], run["status"]) == ("english", "ok")
    assert conn.execute("SELECT query_run_id FROM qlens.assistant_tool_calls").fetchone()["query_run_id"] == run["id"]


def test_run_sql_rows_are_capped(client, applied_fee, use_model):
    login(client)
    seen = {}

    def answer(history):
        seen.update(last_tool_response(history))
        return say("Many.")

    use_model(FakeModel(call("run_sql", sql="SELECT g FROM generate_series(1, 500) g"), answer))
    body = ask(client, applied_fee.id, "list numbers", context="query")
    assert len(seen["result"]["rows"]) == 50 and seen["result"]["truncated"] is True
    assert len(body["sql_runs"][0]["rows"]) == 20 and body["sql_runs"][0]["row_count"] == 50


def test_explain_query_returns_plan_nodes(client, applied_fee, use_model):
    login(client)
    seen = {}

    def answer(history):
        seen.update(last_tool_response(history))
        return say("It scans students.")

    use_model(FakeModel(call("explain_query", sql="SELECT * FROM students s JOIN batches b ON b.id = s.batch_id"),
                        answer))
    ask(client, applied_fee.id, "how does this run?", context="query")
    nodes = seen["result"]["nodes"]
    assert nodes[0]["depth"] == 0 and all(n["cost"] is not None for n in nodes)
    assert {"students", "batches"} <= {n.get("relation_name") for n in nodes}


def test_explain_query_refuses_non_select(client, applied_fee, use_model):
    login(client)
    seen = {}

    def answer(history):
        seen.update(last_tool_response(history))
        return say("No.")

    use_model(FakeModel(call("explain_query", sql="DROP TABLE students"), answer))
    ask(client, applied_fee.id, "explain dropping", context="query")
    assert seen["error"]["code"] == "not_a_select"


def test_describe_schema_and_list_dependencies(client, applied_fee, use_model):
    login(client)
    seen = []

    def grab(history):
        seen.append(last_tool_response(history))
        return call("list_dependencies") if len(seen) == 1 else say("Here is the schema.")

    use_model(FakeModel(call("describe_schema"), grab, grab))
    body = ask(client, applied_fee.id, "what tables are there?")
    schema, deps = seen[0]["result"], seen[1]["result"]
    assert [t["name"] for t in schema["applied_tables"]] == ["students", "batches", "teachers", "fee_register"]
    assert schema["design"]["status"] == "applied" and schema["dataset"]["rows"] == 3000
    assert schema["dataset"]["columns"][0] == {"name": "student_name", "header": "Student Name", "type": "text"}
    bt = next(d for d in deps["dependencies"] if d["lhs"] == ["batch"] and d["rhs"] == "teacher")
    assert bt["kind"] == "exact" and bt["used_in_design"] is True and bt["lhs_headers"] == ["Batch"]
    assert ["student_name", "month"] in deps["candidate_keys"]
    assert [a["summary"] for a in body["actions"]][0] == "Read the workspace schema"


# ---- the loop -------------------------------------------------------------------------------------

def test_query_context_offers_no_edit_tools(client, conn, draft_ws, use_model):
    seen = {}

    def answer(history):
        seen.update(last_tool_response(history))
        return say("I can't edit from here.")

    model = use_model(FakeModel(call("rename_table", table="students", new_name="learners"), answer))
    body = ask(client, draft_ws.id, "rename students", context="query")
    assert not {"rename_table", "undo_last_edit"} & {t.name for t in model.seen[0][2]}
    assert body["intent"] == "answer" and seen["error"]["code"] == "unknown_tool"
    assert "Query screen" in model.seen[0][0]


def test_data_context_reads_but_offers_no_edit_tools(client, conn, draft_ws, use_model):
    model = use_model(FakeModel(say("Read-only here.")))
    body = ask(client, draft_ws.id, "what is in fee_register?", context="data")
    tools_offered = {t.name for t in model.seen[0][2]}
    assert "run_sql" in tools_offered and not {"rename_table", "undo_last_edit"} & tools_offered
    assert "Data screen" in model.seen[0][0]
    conn.rollback()
    row = conn.execute("SELECT context FROM qlens.assistant_conversations WHERE id = %s",
                       (body["conversation_id"],)).fetchone()
    assert row["context"] == "data"
    # a data conversation can't be continued from the design screen
    use_model(FakeModel(say("x")))
    ask(client, draft_ws.id, "and now?", status=409, conversation_id=body["conversation_id"])


def test_undo_endpoint_goes_back_one_version_without_the_model(client, conn, draft_ws, use_model):
    use_model(FakeModel(call("rename_table", table="students", new_name="learners"), say("Renamed.")))
    first = ask(client, draft_ws.id, "rename students to learners")
    assert table_names(first["proposal"])[0] == "learners"
    use_model(FakeModel())   # an empty script: any model call would fail the test
    r = client.post(f"/api/workspaces/{draft_ws.id}/assistant/undo")
    assert r.status_code == 200, r.text
    assert table_names(r.json()["proposal"]) == ["students", "batches", "teachers", "fee_register"]
    conn.rollback()
    assert table_names(live_proposal(conn, draft_ws.dataset_id)) == ["students", "batches", "teachers", "fee_register"]
    # nothing older than the first built draft
    again = client.post(f"/api/workspaces/{draft_ws.id}/assistant/undo")
    assert again.status_code == 409 and again.json()["error"]["code"] == "nothing_to_undo"


def test_undo_endpoint_restores_a_dependency_flip(client, conn, draft_ws, use_model):
    use_model(FakeModel(call("set_dependency_accepted", lhs=["batch"], rhs="teacher", accepted=False), say("Ok.")))
    ask(client, draft_ws.id, "batch doesn't decide teacher")
    conn.rollback()
    assert conn.execute(FD_ACCEPTED).fetchone()["accepted"] is False
    assert client.post(f"/api/workspaces/{draft_ws.id}/assistant/undo").status_code == 200
    conn.rollback()
    assert conn.execute(FD_ACCEPTED).fetchone()["accepted"] is True


def test_undo_endpoint_is_scoped_to_the_owner(client, draft_ws, other_applied_ws):
    assert client.post(f"/api/workspaces/{other_applied_ws.id}/assistant/undo").status_code == 404


def test_tool_rounds_are_capped(client, draft_ws, use_model):
    model = use_model(FakeModel(*[call("describe_schema")] * 6, say("Enough looking.")))
    body = ask(client, draft_ws.id, "look around")
    assert len(body["actions"]) == 6 and body["reply"] == "Enough looking."
    assert [len(tools) > 0 for _, _, tools in model.seen] == [True] * 6 + [False]


def test_history_is_replayed(client, draft_ws, use_model):
    model = use_model(FakeModel(say("Hello!")))
    first = ask(client, draft_ws.id, "hi")
    model = use_model(FakeModel(say("You said hi.")))
    ask(client, draft_ws.id, "what did I say?", conversation_id=first["conversation_id"])
    history = model.seen[0][1]
    assert [(t.role, t.text) for t in history] == [("user", "hi"), ("model", "Hello!"), ("user", "what did I say?")]


def test_model_failure_is_502_and_keeps_nothing(client, conn, draft_ws, use_model):
    class Broken:
        name = "broken"

        def step(self, *_):
            raise ModelError("ServerError: 503 UNAVAILABLE")

    use_model(Broken())
    r = client.post(f"/api/workspaces/{draft_ws.id}/assistant", json={"message": "hi"})
    assert r.status_code == 502 and r.json()["error"]["code"] == "assistant_upstream_error"
    conn.rollback()
    assert conn.execute("SELECT count(*) AS n FROM qlens.assistant_messages").fetchone()["n"] == 0


def _gemini_raising(exc):
    from qlens.assistant.llm import GeminiModel

    class Models:
        def generate_content(self, **_):
            raise exc

    model = GeminiModel("not-a-key", "gemini-test")
    model._client = type("C", (), {"models": Models()})()
    return model


def test_gemini_429_is_a_429_rate_limited_without_the_sdk_text(client, conn, draft_ws, use_model):
    from google.genai import errors

    use_model(_gemini_raising(errors.ClientError(429, {"error": {"code": 429, "message": "quota SECRET-DETAIL",
                                                                 "status": "RESOURCE_EXHAUSTED"}})))
    r = client.post(f"/api/workspaces/{draft_ws.id}/assistant", json={"message": "hi"})
    assert r.status_code == 429
    err = r.json()["error"]
    assert err["code"] == "assistant_rate_limited" and err["detail"] is None and "SECRET" not in r.text
    assert "try again in a minute" in err["message"].lower()
    conn.rollback()
    assert conn.execute("SELECT count(*) AS n FROM qlens.assistant_messages").fetchone()["n"] == 0


def test_other_gemini_errors_stay_502_without_the_sdk_text(client, conn, draft_ws, use_model):
    from google.genai import errors

    use_model(_gemini_raising(errors.ServerError(503, {"error": {"code": 503, "message": "overloaded SECRET-DETAIL",
                                                                 "status": "UNAVAILABLE"}})))
    r = client.post(f"/api/workspaces/{draft_ws.id}/assistant", json={"message": "hi"})
    assert r.status_code == 502
    err = r.json()["error"]
    assert err["code"] == "assistant_upstream_error" and err["detail"] is None and "SECRET" not in r.text


def test_the_final_round_ignores_function_calls(client, draft_ws, use_model):
    # The model keeps calling tools even without any: no seventh round, and its text (none) falls back.
    use_model(FakeModel(*[call("describe_schema")] * 7))
    body = ask(client, draft_ws.id, "look around")
    assert len(body["actions"]) == 6


def test_excess_tool_calls_come_back_as_errors(client, draft_ws, use_model):
    many = ModelStep(text=None, calls=[FunctionCall(name="describe_schema", args={}, id=f"c{i}") for i in range(10)])
    body = ask_with(client, draft_ws, use_model, FakeModel(many, say("ok")))
    assert [a["ok"] for a in body["actions"]] == [True] * 8 + [False] * 2


def test_calls_per_message_are_capped(client, draft_ws, use_model):
    step = ModelStep(text=None, calls=[FunctionCall(name="describe_schema", args={}, id=f"c{i}") for i in range(8)])
    body = ask_with(client, draft_ws, use_model, FakeModel(step, step, step, say("ok")))
    assert [a["ok"] for a in body["actions"]].count(True) == 20 and len(body["actions"]) == 24


def ask_with(client, ws, use_model, model):
    use_model(model)
    return ask(client, ws.id, "look around")


def test_edit_then_model_failure_rolls_the_edit_back(client, conn, draft_ws, use_model):
    before = live_proposal(conn, draft_ws.dataset_id)

    def fail(_):
        raise ModelError("timeout")

    use_model(FakeModel(call("rename_table", table="students", new_name="learners"), fail))
    ask(client, draft_ws.id, "rename students to learners", status=502)
    conn.rollback()
    assert live_proposal(conn, draft_ws.dataset_id).id == before.id


# ---- routes ---------------------------------------------------------------------------------------

def test_disabled_without_key(client, draft_ws):
    r = client.post(f"/api/workspaces/{draft_ws.id}/assistant", json={"message": "hi"})
    assert r.status_code == 503 and r.json()["error"]["code"] == "assistant_disabled"


def test_config_reflects_the_key(client, monkeypatch):
    assert client.get("/api/config").json() == {"assistant_enabled": False, "assistant_model": None}
    monkeypatch.setattr(get_settings(), "gemini_api_key", "test-key")
    monkeypatch.setattr(get_settings(), "gemini_model", "gemini-test")
    assert client.get("/api/config").json() == {"assistant_enabled": True, "assistant_model": "gemini-test"}


@pytest.mark.parametrize("body", [{"message": ""}, {"message": "   "}, {"message": "x" * 2001},
                                  {"message": "hi", "context": "admin"}])
def test_bad_input(client, draft_ws, use_model, body):
    use_model(FakeModel())
    r = client.post(f"/api/workspaces/{draft_ws.id}/assistant", json=body)
    assert r.status_code == 422


def test_conversations_list_and_detail(client, draft_ws, use_model):
    use_model(FakeModel(call("rename_table", table="students", new_name="learners"), say("Renamed.")))
    first = ask(client, draft_ws.id, "rename   students\nto learners")
    use_model(FakeModel(say("You're welcome.")))
    ask(client, draft_ws.id, "thanks", conversation_id=first["conversation_id"])
    use_model(FakeModel(say("Hi.")))
    other = ask(client, draft_ws.id, "hello", context="query")

    listed = client.get(f"/api/workspaces/{draft_ws.id}/assistant/conversations").json()
    assert [(c["id"], c["context"], c["title"], c["message_count"]) for c in listed] == [
        (other["conversation_id"], "query", "hello", 2),
        (first["conversation_id"], "design", "rename students to learners", 4)]
    detail = client.get(f"/api/workspaces/{draft_ws.id}/assistant/conversations/{first['conversation_id']}").json()
    assert [(m["seq"], m["role"], m["intent"]) for m in detail["messages"]] == [
        (1, "user", None), (2, "assistant", "edit"), (3, "user", None), (4, "assistant", "answer")]
    [tc] = detail["messages"][1]["tool_calls"]
    assert (tc["tool"], tc["args"], tc["ok"], tc["result"]["tables"][0]) == (
        "rename_table", {"table": "students", "new_name": "learners"}, True, "learners")
    assert detail["messages"][0]["content"] == "rename   students\nto learners"


def test_conversation_context_must_match(client, draft_ws, use_model):
    use_model(FakeModel(say("Hi.")))
    first = ask(client, draft_ws.id, "hello", context="query")
    use_model(FakeModel(say("Hi.")))
    r = client.post(f"/api/workspaces/{draft_ws.id}/assistant",
                    json={"message": "x", "conversation_id": first["conversation_id"], "context": "design"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "context_mismatch"


def test_cross_workspace_is_404(client, draft_ws, other_applied_ws, use_model):
    use_model(FakeModel(say("Hi.")))
    mine = ask(client, draft_ws.id, "hello")
    base = f"/api/workspaces/{other_applied_ws.id}/assistant"
    assert client.post(base, json={"message": "hi"}).status_code == 404
    assert client.get(f"{base}/conversations").status_code == 404
    # A conversation id from my workspace, asked for under another workspace id.
    assert client.get(f"{base}/conversations/{mine['conversation_id']}").status_code == 404
    client.post("/api/auth/logout")
    assert client.post("/api/auth/login", json={"email": "fixture2@example.com",
                                                "password": "fixture-password"}).status_code == 200
    r = client.post(f"/api/workspaces/{other_applied_ws.id}/assistant",
                    json={"message": "x", "conversation_id": mine["conversation_id"]})
    assert r.status_code == 404 and r.json()["error"]["code"] == "conversation_not_found"
    assert client.get(f"{base}/conversations/{mine['conversation_id']}").status_code == 404


# ---- edit-applied (Design screen) -----------------------------------------------------------------

def test_edit_applied_copies_the_applied_design_with_its_renames(client, conn, fee_ws_clean):
    from qlens.design.apply import apply_proposal
    from qlens.design.proposal import rename_table

    p = build(conn, fee_ws_clean.dataset_id)
    rename_table(conn, fee_ws_clean.dataset_id, p.tables[0].id, "learners")
    apply_proposal(conn, fee_ws_clean.id, p.id)
    conn.commit()
    login(client)
    url = f"/api/workspaces/{fee_ws_clean.id}/proposal/edit-applied"
    r = client.post(url)
    assert r.status_code == 200, r.text
    draft = r.json()
    assert draft["status"] == "draft" and draft["id"] != p.id
    assert table_names(draft) == ["learners", "batches", "teachers", "fee_register"]
    assert client.get(f"/api/workspaces/{fee_ws_clean.id}/proposal").json()["id"] == draft["id"]
    conn.rollback()
    applied = conn.execute("SELECT status FROM qlens.schema_proposals WHERE id = %s", (p.id,)).fetchone()
    assert applied["status"] == "applied"
    # Same shape, new ids.
    original = {t.name: [(c.name, c.role, c.data_type, c.not_null, c.source_column) for c in t.columns]
                for t in live_proposal(conn, fee_ws_clean.dataset_id).tables}
    copied = {t["name"]: [(c["name"], c["role"], c["data_type"], c["not_null"], c["source_column"])
                          for c in t["columns"]] for t in draft["tables"]}
    assert copied == original
    r = client.post(url)
    assert r.status_code == 409 and r.json()["error"]["code"] == "draft_exists"


def test_edit_applied_needs_an_applied_design(client, conn, draft_ws):
    r = client.post(f"/api/workspaces/{draft_ws.id}/proposal/edit-applied")
    assert r.status_code == 409 and r.json()["error"]["code"] == "draft_exists"
    conn.execute("DELETE FROM qlens.schema_proposals")
    conn.commit()
    r = client.post(f"/api/workspaces/{draft_ws.id}/proposal/edit-applied")
    assert r.status_code == 404 and r.json()["error"]["code"] == "no_applied_proposal"


# ---- live (opt-in) --------------------------------------------------------------------------------

@pytest.mark.skipif(not (get_settings().gemini_api_key and os.environ.get("QLENS_LIVE_LLM") == "1"),
                    reason="live Gemini test: set GEMINI_API_KEY and QLENS_LIVE_LLM=1")
def test_live_gemini_renames_and_answers(client, conn, draft_ws):
    r = client.post(f"/api/workspaces/{draft_ws.id}/assistant", json={"message": "rename students to learners"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["intent"] == "edit" and "learners" in table_names(body["proposal"])
    r = client.post(f"/api/workspaces/{draft_ws.id}/assistant", json={"message": "does batch decide the teacher?"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["intent"] == "answer" and any(a["tool"] == "check_dependency" for a in body["actions"])
