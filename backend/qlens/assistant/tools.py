"""The only ways the assistant can act on a workspace.

Every tool validates its arguments server-side and returns compact JSON for the model. None of them takes
DDL or DML: reads go through the analysis tables, qlens.check_fd and the read-only sandbox; edits go through
the same validated functions as the Design screen, on the draft proposal only. Applying a design stays a
user action, so there is no tool for it.

Design versions (undo): an edit never changes the version the user was looking at. The first edit tool in
a user message copies the current draft (or the applied design, when there is no draft) into a new draft
whose based_on_id points back at it; further edits in the same message change that new draft, so one
message is one undo step. A rebuild synthesizes a new draft with the same based_on_id. undo_last_edit
copies the based_on version back as a new draft whose based_on_id is that version's own, so repeated undos
walk back along the chain. Replaced drafts are kept as 'superseded' history.
"""
from collections.abc import Callable
from dataclasses import dataclass, field
from time import perf_counter
from typing import Annotated, Any

import logging

import psycopg
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from qlens import db
from qlens.analysis import cleanup, discover
from qlens.analysis.fd_algebra import closure
from qlens.config import get_settings
from qlens.design import catalog, proposal
from qlens.design.proposal import ProposalOut
from qlens.errors import ApiError
from qlens.query import sandbox
from qlens.query.routes import record_run
from qlens.query.sandbox import QueryError, QueryResult
from qlens.query.validate import validate_select

log = logging.getLogger(__name__)

MODEL_ROWS = 50          # rows of a run_sql result the model sees
REPLY_ROWS = 20          # rows of a run_sql result returned to the client
EXAMPLES = 5             # conflicting groups shown for a broken dependency


class ToolError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class SqlRun:
    sql: str
    row_count: int
    columns: list[dict[str, str]]
    rows: list[list]


@dataclass
class ToolContext:
    conn: psycopg.Connection
    ws_id: int
    # Set by the first edit of the message: the version made for it, and what an undo goes back to.
    version_id: int | None = None
    base_id: int | None = None
    # fd id -> its accepted flag before this message's first flip (undo restores these).
    fd_flips: dict[int, bool] = field(default_factory=dict)
    sql_runs: list[SqlRun] = field(default_factory=list)


@dataclass
class Outcome:
    ok: bool
    result: Any                      # JSON for the model (and the tool_calls row)
    error: str | None
    summary: str                     # one line for the user
    query_run_id: int | None = None


# ---- arguments ------------------------------------------------------------------------------------

Name = Annotated[str, Field(min_length=1, max_length=200)]


class _Args(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NoArgs(_Args):
    pass


class DependencyArgs(_Args):
    lhs: Annotated[list[Name], Field(min_length=1, max_length=3,
                                     description="Determinant column name(s), e.g. [\"batch\"].")]
    rhs: Name = Field(description="The column that may be determined, e.g. \"teacher\".")


class SqlArgs(_Args):
    sql: Annotated[str, Field(min_length=1, max_length=20_000, description="One PostgreSQL SELECT statement.")]


class RenameTableArgs(_Args):
    table: Name = Field(description="Current table name in the draft design.")
    new_name: Name = Field(description="New name: lower-case letters, digits and underscores.")


class RenameColumnArgs(_Args):
    table: Name = Field(description="Table name in the draft design.")
    column: Name = Field(description="Current column name.")
    new_name: Name = Field(description="New name: lower-case letters, digits and underscores.")


class AcceptArgs(DependencyArgs):
    accepted: bool = Field(description="false to stop using this dependency in the design, true to use it again.")


# ---- helpers --------------------------------------------------------------------------------------

def _dataset(ctx: ToolContext) -> dict:
    ds = ctx.conn.execute("SELECT id, status, row_count FROM qlens.datasets WHERE workspace_id = %s",
                          (ctx.ws_id,)).fetchone()
    if ds is None:
        raise ToolError("no_dataset", "This workspace has no dataset yet.")
    return ds


def _columns(ctx: ToolContext, dataset_id: int) -> list[dict]:
    return ctx.conn.execute("SELECT name, label, inferred_type FROM qlens.dataset_columns WHERE dataset_id = %s "
                            "ORDER BY ordinal", (dataset_id,)).fetchall()


def _resolve_column(cols: list[dict], given: str) -> str:
    """A dataset column by its name or its spreadsheet header (any case)."""
    g = given.strip().lower()
    for c in cols:
        if g in (c["name"], c["label"].lower()):
            return c["name"]
    raise ToolError("unknown_column", f"There is no column {given!r}. Columns: {', '.join(c['name'] for c in cols)}.")


def _proposal_brief(p: ProposalOut) -> dict:
    name_of = {t.id: t.name for t in p.tables}
    return {"id": p.id, "status": p.status, "tables": [{
        "name": t.name, "kind": t.kind, "explanation": t.explanation,
        "columns": [{"name": c.name, "type": c.data_type, "role": c.role, "not_null": c.not_null,
                     **({"references": name_of[c.references_table_id]} if c.references_table_id else {}),
                     **({"from_sheet_column": c.source_column} if c.source_column else {})}
                    for c in t.columns],
        "unique_keys": t.unique_keys} for t in p.tables]}


def _draft_row(ctx: ToolContext, dataset_id: int) -> dict | None:
    return ctx.conn.execute("SELECT id, based_on_id, fd_changes FROM qlens.schema_proposals "
                            "WHERE dataset_id = %s AND status = 'draft'", (dataset_id,)).fetchone()


def _live_id(ctx: ToolContext, dataset_id: int) -> int | None:
    row = ctx.conn.execute("SELECT id FROM qlens.schema_proposals WHERE dataset_id = %s AND status <> 'superseded' "
                           "ORDER BY status = 'draft' DESC LIMIT 1", (dataset_id,)).fetchone()
    return None if row is None else row["id"]


def _editable_draft(ctx: ToolContext, dataset_id: int) -> int:
    """The draft this message edits, made on first use (see the module docstring)."""
    draft = _draft_row(ctx, dataset_id)
    if draft is not None and draft["id"] == ctx.version_id:
        return draft["id"]
    base = _live_id(ctx, dataset_id)
    if base is None:
        new = _build(ctx, dataset_id, None).id
    elif draft is None:
        # Only an applied design: the same copy as the Design screen's "edit applied design".
        new = proposal.edit_applied(ctx.conn, dataset_id).id
    else:
        new = proposal.copy_as_draft(ctx.conn, dataset_id, base, based_on_id=base)
    ctx.version_id, ctx.base_id = new, base
    return new


def _build(ctx: ToolContext, dataset_id: int, based_on_id: int | None) -> ProposalOut:
    try:
        return proposal.build(ctx.conn, dataset_id, based_on_id=based_on_id)
    except ApiError as e:
        raise ToolError(e.code, e.message) from None


def _rebuild(ctx: ToolContext, dataset_id: int) -> ProposalOut:
    # A rebuild inside a message that already made a version keeps that message's undo target.
    draft = _draft_row(ctx, dataset_id)
    base = ctx.base_id if draft is not None and draft["id"] == ctx.version_id else _live_id(ctx, dataset_id)
    p = _build(ctx, dataset_id, base)
    ctx.version_id, ctx.base_id = p.id, base
    return p


def _table(p: ProposalOut, name: str):
    for t in p.tables:
        if t.name == name.strip().lower():
            return t
    raise ToolError("unknown_table", f"The draft has no table {name!r}. Tables: {', '.join(t.name for t in p.tables)}.")


def _names(p: ProposalOut) -> list[str]:
    return [t.name for t in p.tables]


def _find_fd(ctx: ToolContext, dataset_id: int, lhs: list[str], rhs: str):
    for f in discover.load_fds(ctx.conn, dataset_id):
        if set(f.lhs) == set(lhs) and f.rhs == rhs:
            return f
    return None


# ---- read tools -----------------------------------------------------------------------------------

def describe_schema(ctx: ToolContext, _: NoArgs) -> tuple[dict, str]:
    ds = _dataset(ctx)
    applied = catalog.describe(ctx.conn, ctx.ws_id, "main").tables
    live = proposal.live_proposal(ctx.conn, ds["id"])
    out = {
        "dataset": {"rows": ds["row_count"], "analyzed": ds["status"] != "imported",
                    "columns": [{"name": c["name"], "header": c["label"], "type": c["inferred_type"]}
                                for c in _columns(ctx, ds["id"])]},
        "applied_tables": [{"name": t["name"], "rows": t["row_count"], "columns": [
            {"name": c["name"], "type": c["data_type"], **({"pk": True} if c["is_pk"] else {}),
             **({"references": f"{c['fk']['table']}.{c['fk']['column']}"} if c["fk"] else {})}
            for c in t["columns"]]} for t in applied],
        "design": _proposal_brief(live) if live else None,
    }
    return out, "Read the workspace schema"


def list_dependencies(ctx: ToolContext, _: NoArgs) -> tuple[dict, str]:
    ds = _dataset(ctx)
    label = {c["name"]: c["label"] for c in _columns(ctx, ds["id"])}
    analysis = discover.get_analysis(ctx.conn, ds["id"]) if ds["status"] != "imported" else None
    if analysis is None:
        raise ToolError("not_analyzed", "The dataset has not been analyzed yet.")
    fds = [{"lhs": f.lhs, "rhs": f.rhs, "lhs_headers": [label[c] for c in f.lhs], "rhs_header": label[f.rhs],
            "kind": "exact" if f.is_exact else "approximate", "violating_rows": f.violating_rows,
            "accepted": f.accepted, "derived": f.is_derived, "used_in_design": f.is_exact and f.accepted and not f.is_derived}
           for f in analysis.fds]
    return ({"rows": analysis.row_count, "candidate_keys": analysis.keys, "dependencies": fds},
            f"Listed {len(fds)} dependencies")


def check_dependency(ctx: ToolContext, a: DependencyArgs) -> tuple[dict, str]:
    ds = _dataset(ctx)
    cols = _columns(ctx, ds["id"])
    lhs = list(dict.fromkeys(_resolve_column(cols, c) for c in a.lhs))
    rhs = _resolve_column(cols, a.rhs)
    if rhs in lhs:
        raise ToolError("trivial_dependency", "The right-hand column is part of the left-hand side.")
    r = ctx.conn.execute("SELECT * FROM qlens.check_fd(%s, '_staging', %s, %s)",
                         (db.ws_schema(ctx.ws_id, "src"), lhs, rhs)).fetchone()
    conflicts = cleanup._conflicts(ctx.conn, ctx.ws_id, lhs, rhs)[:EXAMPLES]
    stored = _find_fd(ctx, ds["id"], lhs, rhs)
    exact = r["violating_rows"] == 0
    out = {"lhs": lhs, "rhs": rhs, "rows": r["row_count"], "lhs_values": r["lhs_values"],
           "repeated_lhs_values": r["repeated_groups"], "violating_rows": r["violating_rows"], "exact": exact,
           "examples": [{"lhs_values": c.lhs_values, "rhs_values": [{"value": v.value, "rows": v.rows}
                                                                    for v in c.variants]} for c in conflicts],
           "stored": None if stored is None else {"accepted": stored.accepted, "derived": stored.is_derived,
                                                  "used_in_design": stored.is_exact and stored.accepted
                                                  and not stored.is_derived}}
    verdict = "holds in every row" if exact else f"broken in {r['violating_rows']} rows"
    return out, f"Checked {' + '.join(lhs)} → {rhs}: {verdict}"


def run_sql(ctx: ToolContext, a: SqlArgs) -> tuple[dict, str] | Outcome:
    sql_text, outcome = a.sql, None
    try:
        sql_text = validate_select(a.sql)
        outcome = sandbox.run(ctx.ws_id, sql_text, target="main", max_rows=MODEL_ROWS)
    except (ApiError, QueryError) as e:
        outcome = e
    run_id = record_run(ctx.conn, ctx.ws_id, sql_text, "english", "main", outcome)
    if not isinstance(outcome, QueryResult):
        # Returned, not raised: raising would roll back the savepoint and lose the history row.
        return Outcome(False, {"code": outcome.code}, outcome.message, f"run_sql failed: {outcome.message}", run_id)
    ctx.sql_runs.append(SqlRun(sql=sql_text, row_count=outcome.row_count, columns=outcome.columns,
                               rows=outcome.rows[:REPLY_ROWS]))
    return ({"columns": [c["name"] for c in outcome.columns], "rows": outcome.rows, "row_count": outcome.row_count,
             "truncated": outcome.truncated, "_query_run_id": run_id},
            f"Ran a query ({outcome.row_count}{'+' if outcome.truncated else ''} rows)")


def _plan_nodes(node: dict, depth: int = 0) -> list[dict]:
    keep = ("Relation Name", "Index Name", "Join Type", "Filter", "Index Cond", "Hash Cond", "Sort Key",
            "Group Key")
    out = [{"depth": depth, "node": node["Node Type"], "est_rows": node.get("Plan Rows"),
            "cost": node.get("Total Cost"), **{k.lower().replace(" ", "_"): node[k] for k in keep if k in node}}]
    for child in node.get("Plans", []):
        out += _plan_nodes(child, depth + 1)
    return out


def explain_query(ctx: ToolContext, a: SqlArgs) -> tuple[dict, str]:
    try:
        sql_text = validate_select(a.sql)
    except ApiError as e:
        raise ToolError(e.code, e.message) from None
    # The same sandbox as sandbox.run (workspace role, read-only transaction, statement timeout); plain
    # EXPLAIN plans the query without running it.
    # TODO: reuse the sandbox's explain helper (explain_analyze work in query/sandbox.py) once it is committed.
    s = get_settings()
    try:
        conn = psycopg.connect(host=s.pg_host, port=s.pg_port, dbname=s.pg_dbname, user=db.ws_role(ctx.ws_id),
                               password=db.ws_password(ctx.ws_id), connect_timeout=5,
                               options=f"-c search_path={db.ws_schema(ctx.ws_id, 'main')},{db.ws_schema(ctx.ws_id, 'src')}")
    except psycopg.Error as e:
        log.warning("explain_query: sandbox connection failed: %s", e)
        raise ToolError("db_error", "The database is not reachable right now.") from None
    started = perf_counter()
    try:
        conn.read_only = True
        conn.execute("SELECT set_config('statement_timeout', %s, true)", (str(sandbox.MAX_TIMEOUT_MS),))
        plan = conn.execute("EXPLAIN (FORMAT JSON) " + sql_text, prepare=True).fetchone()[0][0]
    except psycopg.Error as e:
        log.warning("explain_query failed: %s", e)
        if e.sqlstate == "53300":
            raise ToolError("too_busy", "The database is busy; try again in a moment.") from None
        if (e.sqlstate or "").startswith("42"):   # syntax error, unknown table or column: the model can fix these
            raise ToolError("db_error", e.diag.message_primary or "The query is not valid.") from None
        raise ToolError("db_error", "PostgreSQL could not plan this query.") from None
    finally:
        conn.rollback()
        conn.close()
    nodes = _plan_nodes(plan["Plan"])
    return ({"nodes": nodes, "planning_ms": round((perf_counter() - started) * 1000, 2)},
            f"Explained a query ({nodes[0]['node']}, {len(nodes)} plan nodes)")


# ---- edit tools -----------------------------------------------------------------------------------

def rename_table(ctx: ToolContext, a: RenameTableArgs) -> tuple[dict, str]:
    ds = _dataset(ctx)
    draft = proposal.get_proposal(ctx.conn, _editable_draft(ctx, ds["id"]))
    t = _table(draft, a.table)
    p = proposal.rename_table(ctx.conn, ds["id"], t.id, a.new_name)
    return {"tables": _names(p)}, f"Renamed table {t.name} to {a.new_name}"


def rename_column(ctx: ToolContext, a: RenameColumnArgs) -> tuple[dict, str]:
    ds = _dataset(ctx)
    draft = proposal.get_proposal(ctx.conn, _editable_draft(ctx, ds["id"]))
    t = _table(draft, a.table)
    c = next((c for c in t.columns if c.name == a.column.strip().lower()), None)
    if c is None:
        raise ToolError("unknown_column",
                        f"{t.name} has no column {a.column!r}. Columns: {', '.join(c.name for c in t.columns)}.")
    p = proposal.rename_column(ctx.conn, ds["id"], c.id, a.new_name)
    return ({"table": t.name, "columns": [c.name for c in _table(p, t.name).columns]},
            f"Renamed {t.name}.{c.name} to {a.new_name}")


def set_dependency_accepted(ctx: ToolContext, a: AcceptArgs) -> tuple[dict, str]:
    ds = _dataset(ctx)
    cols = _columns(ctx, ds["id"])
    lhs = [_resolve_column(cols, c) for c in a.lhs]
    rhs = _resolve_column(cols, a.rhs)
    fd = _find_fd(ctx, ds["id"], lhs, rhs)
    if fd is None:
        raise ToolError("unknown_dependency",
                        f"No dependency {' + '.join(lhs)} → {rhs} was found in the data; list_dependencies shows them.")
    ctx.conn.execute("UPDATE qlens.functional_dependencies SET accepted = %s WHERE id = %s AND dataset_id = %s",
                     (a.accepted, fd.id, ds["id"]))
    ctx.fd_flips.setdefault(fd.id, fd.accepted)
    p = _rebuild(ctx, ds["id"])
    # Recorded on the version this message made, so undoing it can put the flags back.
    ctx.conn.execute("UPDATE qlens.schema_proposals SET fd_changes = %s WHERE id = %s",
                     (Jsonb({str(k): v for k, v in ctx.fd_flips.items()}), p.id))
    out: dict[str, Any] = {"dependency": {"lhs": lhs, "rhs": rhs, "accepted": a.accepted, "exact": fd.is_exact}}
    if not a.accepted:
        # Other accepted dependencies can still imply it (batch -> teacher_phone -> teacher), in which case
        # the design keeps linking the columns; say which, so the model can explain it.
        used = discover.to_algebra(discover.load_fds(ctx.conn, ds["id"]))
        reach = closure(lhs, used)
        if rhs in reach:
            out["still_implied_by"] = [{"lhs": sorted(f.lhs), "rhs": f.rhs} for f in used
                                       if f.lhs <= reach and f.rhs not in lhs]
    out["design"] = _proposal_brief(p)
    verb = "Using" if a.accepted else "Stopped using"
    return (out,
            f"{verb} {' + '.join(lhs)} → {rhs} and rebuilt the design")


def rebuild_design(ctx: ToolContext, _: NoArgs) -> tuple[dict, str]:
    p = _rebuild(ctx, _dataset(ctx)["id"])
    return {"design": _proposal_brief(p)}, "Rebuilt the design from the accepted dependencies"


def undo_last_edit(ctx: ToolContext, _: NoArgs) -> tuple[dict, str]:
    ds = _dataset(ctx)
    draft = _draft_row(ctx, ds["id"])
    if draft is None or draft["based_on_id"] is None:
        raise ToolError("nothing_to_undo", "There is no earlier version of the draft to go back to.")
    target = ctx.conn.execute("SELECT id, based_on_id, fd_changes FROM qlens.schema_proposals WHERE id = %s",
                              (draft["based_on_id"],)).fetchone()
    # Put back the dependency flags the undone version changed.
    for fd_id, was in (draft["fd_changes"] or {}).items():
        ctx.conn.execute("UPDATE qlens.functional_dependencies SET accepted = %s WHERE id = %s AND dataset_id = %s",
                         (was, int(fd_id), ds["id"]))
    new = proposal.copy_as_draft(ctx.conn, ds["id"], target["id"], based_on_id=target["based_on_id"])
    # The restored version keeps its own flips, so a further undo reverts those too.
    ctx.conn.execute("UPDATE qlens.schema_proposals SET fd_changes = %s WHERE id = %s",
                     (None if target["fd_changes"] is None else Jsonb(target["fd_changes"]), new))
    ctx.fd_flips = {}
    # The next edit in this message starts a fresh version from the restored one.
    ctx.version_id = ctx.base_id = None
    return {"tables": _names(proposal.get_proposal(ctx.conn, new))}, "Undid the last design change"


# ---- registry -------------------------------------------------------------------------------------

@dataclass
class Tool:
    name: str
    description: str
    args: type[_Args]
    fn: Callable[[ToolContext, Any], "tuple[Any, str] | Outcome"]
    edit: bool = False


TOOLS: dict[str, Tool] = {t.name: t for t in [
    Tool("describe_schema", "The workspace's spreadsheet columns, the tables that exist (applied design) and the "
         "current draft design with its tables, columns, keys, foreign keys and explanations.", NoArgs,
         describe_schema),
    Tool("list_dependencies", "Every functional dependency found in the data (exact or approximate, accepted, "
         "derived, used in the design) and the candidate keys.", NoArgs, list_dependencies),
    Tool("check_dependency", "Check in the data whether the lhs column(s) determine the rhs column: how many rows "
         "break it, with up to 5 conflicting examples.", DependencyArgs, check_dependency),
    Tool("run_sql", "Run one read-only SELECT on the applied tables (PostgreSQL). Returns at most 50 rows.",
         SqlArgs, run_sql),
    Tool("explain_query", "Show PostgreSQL's plan for a SELECT on the applied tables (EXPLAIN, not run).",
         SqlArgs, explain_query),
    Tool("rename_table", "Rename a table of the draft design.", RenameTableArgs, rename_table, edit=True),
    Tool("rename_column", "Rename a column of a table in the draft design.", RenameColumnArgs, rename_column,
         edit=True),
    Tool("set_dependency_accepted", "Stop (accepted=false) or resume (true) using a dependency found in the data, "
         "then rebuild the draft design from the accepted ones.", AcceptArgs, set_dependency_accepted, edit=True),
    Tool("rebuild_design", "Rebuild the draft design from the accepted dependencies (drops renames).", NoArgs,
         rebuild_design, edit=True),
    Tool("undo_last_edit", "Go back to the draft design as it was before the last change.", NoArgs, undo_last_edit,
         edit=True),
]}


def schema_of(tool: Tool) -> dict:
    """JSON schema of a tool's arguments without pydantic's titles (they only add noise for the model)."""
    def strip(node):
        if isinstance(node, dict):
            return {k: strip(v) for k, v in node.items() if k != "title"}
        if isinstance(node, list):
            return [strip(v) for v in node]
        return node
    schema = strip(tool.args.model_json_schema())
    schema.pop("additionalProperties", None)
    return schema


def execute(ctx: ToolContext, name: str, args: dict) -> Outcome:
    """Run one tool call. Every failure comes back as an Outcome for the model; nothing raises to the client.

    Each call runs in its own savepoint, so a failed edit leaves the draft exactly as it was."""
    tool = TOOLS.get(name)
    if tool is None:
        return Outcome(False, {"code": "unknown_tool"}, f"There is no tool {name!r}.", f"Unknown tool {name}")
    try:
        parsed = tool.args.model_validate(args or {})
    except ValidationError as e:
        msg = "; ".join(f"{'.'.join(map(str, err['loc'])) or 'arguments'}: {err['msg']}" for err in e.errors())
        return Outcome(False, {"code": "invalid_arguments"}, msg, f"{name} failed: invalid arguments")
    saved = (ctx.version_id, ctx.base_id, dict(ctx.fd_flips))
    try:
        with ctx.conn.transaction():
            done = tool.fn(ctx, parsed)
    except (ToolError, ApiError) as e:
        ctx.version_id, ctx.base_id, ctx.fd_flips = saved
        return Outcome(False, {"code": e.code}, e.message, f"{name} failed: {e.message}")
    if isinstance(done, Outcome):
        return done
    result, summary = done
    run_id = result.pop("_query_run_id", None) if isinstance(result, dict) else None
    return Outcome(True, result, None, summary, run_id)
