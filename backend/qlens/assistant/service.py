"""One assistant turn: replay the conversation, let the model call tools until it answers, persist it all."""
from datetime import datetime
from typing import Any, Literal

import logging

import psycopg
from psycopg.types.json import Jsonb
from pydantic import BaseModel

from qlens.assistant import tools
from qlens.assistant.llm import ChatModel, ModelError, ToolResult, ToolSpec, Turn
from qlens.design import proposal
from qlens.design.proposal import ProposalOut
from qlens.errors import ApiError

log = logging.getLogger(__name__)

MAX_TOOL_ROUNDS = 6
MAX_CALLS_PER_STEP = 8
MAX_CALLS_PER_MESSAGE = 20
HISTORY_MESSAGES = 20
Context = Literal["design", "query", "data"]


class Action(BaseModel):
    tool: str
    args: dict[str, Any]
    ok: bool
    summary: str


class SqlRunOut(BaseModel):
    sql: str
    row_count: int
    columns: list[dict[str, str]]
    rows: list[list]


class AssistantReply(BaseModel):
    conversation_id: int
    message_id: int
    intent: Literal["answer", "edit"]
    reply: str
    actions: list[Action]
    proposal: ProposalOut | None
    sql_runs: list[SqlRunOut]


SYSTEM = """You are the QLens assistant. QLens turns a spreadsheet into a normalized (3NF) PostgreSQL schema: it \
finds functional dependencies in the data ("each Batch has exactly one Teacher"), synthesizes tables from the \
exact, accepted ones, and the user applies the design after a lossless-join check. The user may not be technical: \
use plain language, short sentences, and name tables and columns in `code`.

How to work:
- Tools are the only way to learn about or change the workspace. Never guess facts about the data; check them.
- Questions ("why is X in Y?", "does A decide B?", "how many ..."): answer concisely and cite the evidence you \
used (the dependency check numbers, or the SQL you ran and what it returned). Use check_dependency for "does A \
decide/determine B" questions, run_sql for questions about the stored rows.
- Change requests ("rename students to learners", "batch does not really decide teacher"): use the edit tools \
on the draft design, then say in one or two sentences what changed. Table and column names must be lower-case \
letters, digits and underscores; convert the user's wording ("Learners" -> learners) yourself.
- If a tool returns an error, explain it plainly or retry with corrected arguments.
- Refuse changes that would break 3NF or make the design lossy (for example moving a column to a table whose key \
does not determine it), and say why in one sentence.
- You cannot apply the design, change data, or run anything but a single SELECT: applying is the user's action \
on the Design screen.
"""

QUERY_NOTE = """You are on the Query screen: answer questions and write/run read-only SELECTs on the applied \
tables. Design edits are made on the Design screen, so you have no edit tools here.
"""

DATA_NOTE = """You are on the Data screen: answer questions about the stored rows and write/run read-only \
SELECTs on the applied tables. Design edits are made on the Design screen, so you have no edit tools here.
"""

# Screens other than Design only read: no edit tools, and a note that says so.
NOTES: dict[str, str] = {"design": "", "query": QUERY_NOTE, "data": DATA_NOTE}


def _summary(conn: psycopg.Connection, ws_id: int) -> str:
    """A few lines about the workspace so the model starts oriented (it can always call describe_schema)."""
    ds = conn.execute("SELECT id, original_filename, status, row_count FROM qlens.datasets WHERE workspace_id = %s",
                      (ws_id,)).fetchone()
    if ds is None:
        return "The workspace has no dataset yet."
    cols = [r["name"] for r in conn.execute(
        "SELECT name FROM qlens.dataset_columns WHERE dataset_id = %s ORDER BY ordinal", (ds["id"],))]
    lines = [f"Dataset: {ds['original_filename']} ({ds['row_count']} rows, status {ds['status']}); "
             f"columns: {', '.join(cols)}."]
    for status in ("draft", "applied"):
        row = conn.execute("SELECT id FROM qlens.schema_proposals WHERE dataset_id = %s AND status = %s",
                           (ds["id"], status)).fetchone()
        if row is not None:
            names = [r["name"] for r in conn.execute(
                "SELECT name FROM qlens.proposed_tables WHERE proposal_id = %s ORDER BY ordinal", (row["id"],))]
            lines.append(f"{status.capitalize()} design tables: {', '.join(names)}.")
    return "\n".join(lines)


def _conversation(conn: psycopg.Connection, ws_id: int, conversation_id: int | None, context: Context,
                  message: str) -> int:
    if conversation_id is None:
        title = " ".join(message.split())[:80]
        return conn.execute("INSERT INTO qlens.assistant_conversations (workspace_id, context, title) "
                            "VALUES (%s, %s, %s) RETURNING id", (ws_id, context, title)).fetchone()["id"]
    # FOR UPDATE: two messages sent at once to one conversation would otherwise take the same seq.
    row = conn.execute("SELECT id, context FROM qlens.assistant_conversations WHERE id = %s AND workspace_id = %s "
                       "FOR UPDATE", (conversation_id, ws_id)).fetchone()
    if row is None:
        raise ApiError(404, "conversation_not_found", "Conversation not found.")
    if row["context"] != context:
        raise ApiError(409, "context_mismatch", f"This conversation belongs to the {row['context']} screen.")
    return row["id"]


def _history(conn: psycopg.Connection, conversation_id: int) -> list[Turn]:
    rows = conn.execute(
        "SELECT role, content FROM (SELECT seq, role, content FROM qlens.assistant_messages "
        "WHERE conversation_id = %s ORDER BY seq DESC LIMIT %s) m ORDER BY seq",
        (conversation_id, HISTORY_MESSAGES)).fetchall()
    return [Turn(role="user" if r["role"] == "user" else "model", text=r["content"]) for r in rows]


def _add_message(conn: psycopg.Connection, conversation_id: int, role: str, content: str,
                 intent: str | None) -> int:
    return conn.execute(
        "INSERT INTO qlens.assistant_messages (conversation_id, seq, role, content, intent) "
        "SELECT %s, coalesce(max(seq), 0) + 1, %s, %s, %s FROM qlens.assistant_messages WHERE conversation_id = %s "
        "RETURNING id", (conversation_id, role, content, intent, conversation_id)).fetchone()["id"]


def respond(conn: psycopg.Connection, ws_id: int, user_id: int, message: str, conversation_id: int | None,
            context: Context, model: ChatModel) -> AssistantReply:
    """user_id is the workspace owner (the route has checked ownership); kept for the call contract."""
    cid = _conversation(conn, ws_id, conversation_id, context, message)
    history = _history(conn, cid)
    _add_message(conn, cid, "user", message, None)

    allowed = [t for t in tools.TOOLS.values() if context == "design" or not t.edit]
    specs = [ToolSpec(t.name, t.description, tools.schema_of(t)) for t in allowed]
    names = {t.name for t in allowed}
    system = SYSTEM + NOTES[context] + "\nWorkspace now:\n" + _summary(conn, ws_id)

    ctx = tools.ToolContext(conn=conn, ws_id=ws_id)
    turns = [*history, Turn(role="user", text=message)]
    calls: list[tuple[str, dict, tools.Outcome]] = []
    reply = None
    try:
        for round_no in range(MAX_TOOL_ROUNDS + 1):
            # After the last allowed round the model gets no tools, so it has to answer in words.
            step = model.step(system, turns, specs if round_no < MAX_TOOL_ROUNDS else [])
            # In the last, tool-less round any function call the model still returns is ignored.
            if not step.calls or round_no >= MAX_TOOL_ROUNDS:
                reply = step.text
                break
            turns.append(Turn(role="model", text=step.text, calls=step.calls, raw=step.raw))
            results = []
            for idx, call in enumerate(step.calls):
                if idx >= MAX_CALLS_PER_STEP or len(calls) >= MAX_CALLS_PER_MESSAGE:
                    outcome = tools.Outcome(False, {"code": "too_many_calls"}, "Too many tool calls; make fewer.",
                                            f"{call.name} skipped: too many tool calls")
                else:
                    outcome = (tools.execute(ctx, call.name, call.args) if call.name in names else
                               tools.Outcome(False, {"code": "unknown_tool"}, f"There is no tool {call.name!r} here.",
                                             f"Unknown tool {call.name}"))
                calls.append((call.name, call.args, outcome))
                results.append(ToolResult(name=call.name, id=call.id, response=(
                    {"result": outcome.result} if outcome.ok else {"error": {**outcome.result, "message": outcome.error}})))
            turns.append(Turn(role="tool", results=results))
    except ModelError as e:
        # Raised, so the request transaction rolls back: no half-finished turn (or edit) is kept.
        log.warning("assistant model call failed: %s", str(e)[:500])
        if e.rate_limited:
            raise ApiError(429, "assistant_rate_limited", "Gemini's free tier is rate-limited right now. Wait about a minute and try "
                           "again — if it keeps happening, today's free quota may be used up (it resets at "
                           "midnight Pacific time).") from None
        raise ApiError(502, "assistant_upstream_error", "The assistant could not get an answer from Gemini. "
                       "Try again in a moment.") from None

    edited = any(o.ok and tools.TOOLS[name].edit for name, _, o in calls)
    intent = "edit" if edited else "answer"
    reply = (reply or "").strip() or ("Done." if edited else "I could not find an answer to that.")
    mid = _add_message(conn, cid, "assistant", reply, intent)
    for seq, (name, args, o) in enumerate(calls, start=1):
        conn.execute(
            "INSERT INTO qlens.assistant_tool_calls (message_id, seq, tool, args, ok, result, error, query_run_id) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (mid, seq, name, Jsonb(args), o.ok, Jsonb(o.result), o.error, o.query_run_id))
    conn.execute("UPDATE qlens.assistant_conversations SET updated_at = now() WHERE id = %s", (cid,))

    live = None
    if edited:
        ds = conn.execute("SELECT id FROM qlens.datasets WHERE workspace_id = %s", (ws_id,)).fetchone()
        live = proposal.live_proposal(conn, ds["id"])
    return AssistantReply(
        conversation_id=cid, message_id=mid, intent=intent, reply=reply,
        actions=[Action(tool=n, args=a, ok=o.ok, summary=o.summary) for n, a, o in calls],
        proposal=live, sql_runs=[SqlRunOut(**vars(r)) for r in ctx.sql_runs])


# ---- undo without the model ------------------------------------------------------------------------

class UndoOut(BaseModel):
    proposal: ProposalOut


def undo(conn: psycopg.Connection, ws_id: int) -> UndoOut:
    """The edit toast's Undo: the assistant's own undo_last_edit, run directly (no model call, so it costs no
    quota and always does the same thing). It goes back one design version, dependency flips included."""
    outcome = tools.execute(tools.ToolContext(conn=conn, ws_id=ws_id), "undo_last_edit", {})
    if not outcome.ok:
        code = outcome.result.get("code", "undo_failed")
        status = 409 if code == "nothing_to_undo" else 404 if code == "no_dataset" else 400
        raise ApiError(status, code, outcome.error or "Could not undo.")
    ds = conn.execute("SELECT id FROM qlens.datasets WHERE workspace_id = %s", (ws_id,)).fetchone()
    return UndoOut(proposal=proposal.live_proposal(conn, ds["id"]))


# ---- reading conversations ------------------------------------------------------------------------

class ConversationOut(BaseModel):
    id: int
    context: Context
    title: str
    updated_at: datetime
    message_count: int


class ToolCallOut(BaseModel):
    seq: int
    tool: str
    args: dict[str, Any]
    ok: bool
    result: Any
    error: str | None
    query_run_id: int | None


class MessageOut(BaseModel):
    id: int
    seq: int
    role: Literal["user", "assistant"]
    content: str
    intent: Literal["answer", "edit"] | None
    created_at: datetime
    tool_calls: list[ToolCallOut]


class ConversationDetail(BaseModel):
    id: int
    context: Context
    title: str
    created_at: datetime
    updated_at: datetime
    messages: list[MessageOut]


def list_conversations(conn: psycopg.Connection, ws_id: int) -> list[ConversationOut]:
    rows = conn.execute(
        "SELECT c.id, c.context, c.title, c.updated_at, "
        "       (SELECT count(*) FROM qlens.assistant_messages m WHERE m.conversation_id = c.id) AS message_count "
        "FROM qlens.assistant_conversations c WHERE c.workspace_id = %s ORDER BY c.updated_at DESC, c.id DESC",
        (ws_id,)).fetchall()
    return [ConversationOut(**r) for r in rows]


def get_conversation(conn: psycopg.Connection, ws_id: int, conversation_id: int) -> ConversationDetail:
    c = conn.execute("SELECT id, context, title, created_at, updated_at FROM qlens.assistant_conversations "
                     "WHERE id = %s AND workspace_id = %s", (conversation_id, ws_id)).fetchone()
    if c is None:
        raise ApiError(404, "conversation_not_found", "Conversation not found.")
    messages = conn.execute("SELECT id, seq, role, content, intent, created_at FROM qlens.assistant_messages "
                            "WHERE conversation_id = %s ORDER BY seq", (conversation_id,)).fetchall()
    calls = conn.execute(
        "SELECT t.message_id, t.seq, t.tool, t.args, t.ok, t.result, t.error, t.query_run_id "
        "FROM qlens.assistant_tool_calls t JOIN qlens.assistant_messages m ON m.id = t.message_id "
        "WHERE m.conversation_id = %s ORDER BY m.seq, t.seq", (conversation_id,)).fetchall()
    of: dict[int, list[ToolCallOut]] = {m["id"]: [] for m in messages}
    for t in calls:
        of[t.pop("message_id")].append(ToolCallOut(**t))
    return ConversationDetail(**c, messages=[MessageOut(**m, tool_calls=of[m["id"]]) for m in messages])
