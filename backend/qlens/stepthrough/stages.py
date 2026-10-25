"""Splits one SELECT into the stages PostgreSQL evaluates it in, and runs each stage in the sandbox.

FROM/JOIN -> WHERE -> GROUP BY -> HAVING -> SELECT -> DISTINCT -> ORDER BY/LIMIT, in relational-algebra terms:
join (or product), selection, grouping, selection on groups, projection, duplicate elimination, sort.
Every stage is a complete, runnable SELECT built from the original's own clauses (deparsed by pglast.stream),
so its rows are real.

Parsing: the statement first passes validate_select (4,000-token cap, iterative JSON walk). The stage SQL needs
the node tree and pglast's deparser, whose Cython tree builder recurses once per nesting level and kills the
process somewhere past ~5,000 levels of `1+1+...`. Within the validator's cap it was measured not to crash
(2,600 tokens, ~1,300 levels, tree built fine in a worker thread), and before building the tree we also refuse
anything nested deeper than MAX_DEPTH levels of the JSON parse tree (counted iteratively), which keeps both the
builder and the recursive deparser far from their limits.
"""

import json
from typing import Literal

from pglast import ast, parse_sql, parser
from pglast.enums import LimitOption
from pglast.stream import IndentedStream, RawStream
from pydantic import BaseModel

from qlens.errors import ApiError
from qlens.query import sandbox
from qlens.query.validate import validate_select

StageKind = Literal["from", "where", "group_by", "having", "select", "distinct", "order_limit"]

SAMPLE_ROWS = 50
# A three-join lab query with a subquery in WHERE is ~40 levels deep; `1+1+...` adds two levels per operator.
MAX_DEPTH = 300


class StageSql(BaseModel):
    kind: StageKind
    sql: str
    title: str
    symbol: str
    clause: str = ""  # the clause text the caption quotes (WHERE condition, group expressions, ...)


class StageOut(BaseModel):
    kind: StageKind
    title: str
    symbol: str
    caption: str
    sql: str
    row_count: int
    columns: list[dict[str, str]]
    rows: list[list]
    duration_ms: float


def _unsupported(message: str) -> ApiError:
    return ApiError(422, "stepthrough_unsupported", message)


# ---- checks on the JSON parse tree (iterative: depth cannot exhaust the stack) ---------------------

def _check_tree(select: dict) -> None:
    """Depth cap, plus constructs that have no place in the stage sequence.

    Nested SELECTs (subqueries) are only depth-counted: a window function or ROLLUP inside one is just part of
    an expression or a FROM item, not a stage of the outer query.
    """
    if select.get("windowClause"):
        raise _unsupported(_WINDOW)
    stack: list[tuple[object, int, bool]] = [(select, 1, True)]
    while stack:
        item, depth, top = stack.pop()
        if depth > MAX_DEPTH:
            raise _unsupported("This query is nested too deeply to show stage by stage. Simplify it.")
        if isinstance(item, list):
            stack.extend((v, depth + 1, top) for v in item)
        elif isinstance(item, dict):
            for key, val in item.items():
                if top and key == "FuncCall" and val.get("over") is not None:
                    raise _unsupported(_WINDOW)
                if top and key == "GroupingSet":
                    raise _unsupported("GROUPING SETS, ROLLUP and CUBE make several groupings at once; "
                                       "step-through shows one GROUP BY at a time.")
                if isinstance(val, (dict, list)):
                    stack.append((val, depth + 1, top and key != "SelectStmt"))


_WINDOW = ("Window functions (OVER) are computed after grouping, over rows that stay separate; "
           "step-through does not show that stage. Try the query without OVER.")


# ---- building stage SQL from the node tree --------------------------------------------------------

def _sql(node) -> str:
    """One-line text of an expression, for captions."""
    return RawStream()(node)


def _statement(node: ast.SelectStmt) -> str:
    """A stage's SELECT, one clause per line (IndentedStream is RawStream with layout), so the UI can show and
    mark the lines each stage adds."""
    return IndentedStream(compact_lists_margin=60)(node)


def _select(base: ast.SelectStmt | None = None, **fields) -> str:
    """Deparse a SELECT made of `base`'s clauses with `fields` replaced (subnodes are shared, never mutated)."""
    attrs = {k: getattr(base, k) for k in ast.SelectStmt.__slots__} if base is not None else {}
    attrs.update(fields)
    return _statement(ast.SelectStmt(**attrs))


_STAR = (ast.ResTarget(val=ast.ColumnRef(fields=(ast.A_Star(),))),)
_ROWS_IN_GROUP = ast.ResTarget(name="rows_in_group", val=ast.FuncCall(funcname=(ast.String(sval="count"),),
                                                                       agg_star=True))


def _relations(items) -> list[str]:
    """Display names of the relations in a FROM list, left to right."""
    names: list[str] = []
    stack = list(reversed(items))
    while stack:
        item = stack.pop()
        if isinstance(item, ast.JoinExpr):
            stack.extend([item.rarg, item.larg])
        elif isinstance(item, ast.RangeVar):
            names.append(item.relname)
        elif isinstance(item, ast.RangeSubselect):
            names.append(f"subquery {item.alias.aliasname}" if item.alias else "a subquery")
        elif getattr(item, "alias", None) is not None:
            names.append(item.alias.aliasname)
        else:
            names.append("a function")
    return names


def _from_title(items) -> tuple[str, str]:
    if any(isinstance(i, ast.JoinExpr) for i in items):
        return "Join (FROM)", "⋈"
    if len(items) > 1:
        return "Cartesian product (FROM)", "×"
    return "Relation (FROM)", "R"


def _group_parts(stmt: ast.SelectStmt) -> tuple[list, list]:
    """(select-list entries, GROUP BY items) for the grouping stage.

    `GROUP BY 1` means the first output column; in the stage's own select list it would mean the constant 1, so
    ordinals are replaced by the expression. An output alias (`GROUP BY who`) stays in GROUP BY and the stage
    selects the aliased expression under the same name, so PostgreSQL resolves it exactly as in the original.
    """
    targets = list(stmt.targetList or ())
    aliases = {t.name: t for t in targets if t.name}
    out, group = [], []
    for item in stmt.groupClause or ():
        if isinstance(item, ast.A_Const) and isinstance(item.val, ast.Integer) and 1 <= item.val.ival <= len(targets):
            t = targets[item.val.ival - 1]
            out.append(ast.ResTarget(name=t.name, val=t.val))
            group.append(t.val)
            continue
        if (isinstance(item, ast.ColumnRef) and len(item.fields) == 1 and isinstance(item.fields[0], ast.String)
                and item.fields[0].sval in aliases):
            t = aliases[item.fields[0].sval]
            out.append(ast.ResTarget(name=t.name, val=t.val))
        else:
            out.append(ast.ResTarget(val=item))
        group.append(item)
    return out, group


def _order_title(stmt: ast.SelectStmt) -> tuple[str, str]:
    sort, limit = bool(stmt.sortClause), stmt.limitCount is not None or stmt.limitOffset is not None
    if sort and limit:
        return "Sort and limit (ORDER BY … LIMIT)", "Sort and limit"
    if sort:
        return "Sort (ORDER BY)", "Sort"
    return "Limit (LIMIT)", "Limit"


def _parse(sql_text: str) -> ast.SelectStmt:
    tree = json.loads(parser.parse_sql_json(sql_text))  # validate_select already accepted this text
    select = tree["stmts"][0]["stmt"]["SelectStmt"]
    if select.get("op", "SETOP_NONE") != "SETOP_NONE":
        raise _unsupported("UNION, INTERSECT and EXCEPT combine two whole queries; step-through follows one "
                           "SELECT at a time. Step through each side on its own.")
    if select.get("withClause"):
        raise _unsupported("WITH queries are not split into stages yet. Write the WITH part as a subquery in "
                           "FROM and try again.")
    if not select.get("fromClause"):
        raise _unsupported("Step-through follows rows from tables, and this query has no FROM clause.")
    _check_tree(select)
    return parse_sql(sql_text)[0].stmt


def build_stages(sql_text: str) -> list[StageSql]:
    stmt = _parse(validate_select(sql_text))
    try:
        return _build(stmt)
    except RecursionError:
        raise _unsupported("This query is nested too deeply to show stage by stage. Simplify it.") from None


def _build(stmt: ast.SelectStmt) -> list[StageSql]:
    stages: list[StageSql] = []
    frm, where = stmt.fromClause, stmt.whereClause

    title, symbol = _from_title(frm)
    stages.append(StageSql(kind="from", sql=_select(targetList=_STAR, fromClause=frm), title=title, symbol=symbol,
                           clause=", ".join(_relations(frm))))
    if where is not None:
        stages.append(StageSql(kind="where", sql=_select(targetList=_STAR, fromClause=frm, whereClause=where),
                               title="Selection (WHERE)", symbol="σ", clause=_sql(where)))

    if stmt.groupClause or stmt.havingClause is not None:
        targets, group = _group_parts(stmt)
        grouped = dict(targetList=(*targets, _ROWS_IN_GROUP), fromClause=frm, whereClause=where,
                       groupClause=tuple(group) or None, groupDistinct=stmt.groupDistinct)
        if group:
            stages.append(StageSql(kind="group_by", sql=_select(**grouped), title="Grouping (GROUP BY)",
                                   symbol="γ", clause=", ".join(_sql(g) for g in group)))
        if stmt.havingClause is not None:
            stages.append(StageSql(kind="having", sql=_select(**grouped, havingClause=stmt.havingClause),
                                   title="Selection on groups (HAVING)", symbol="σ",
                                   clause=_sql(stmt.havingClause)))

    unordered = dict(sortClause=None, limitCount=None, limitOffset=None,
                     limitOption=LimitOption.LIMIT_OPTION_DEFAULT)
    stages.append(StageSql(kind="select", sql=_select(stmt, distinctClause=None, **unordered),
                           title="Projection (SELECT)", symbol="π"))
    if stmt.distinctClause:
        on = [d for d in stmt.distinctClause if d is not None]
        stages.append(StageSql(kind="distinct", sql=_select(stmt, **unordered),
                               title="Duplicate elimination (DISTINCT)", symbol="δ",
                               clause=", ".join(_sql(d) for d in on)))
    if stmt.sortClause or stmt.limitCount is not None or stmt.limitOffset is not None:
        title, verb = _order_title(stmt)
        stages.append(StageSql(kind="order_limit", sql=_statement(stmt), title=title, symbol="τ", clause=verb))
    return stages


# ---- running ---------------------------------------------------------------------------------------

def _plural(n: int, word: str) -> str:
    return f"{n:,} {word}" + ("" if n == 1 else "s")


def _caption(st: StageSql, n: int, prev: int | None) -> str:
    removed = "" if prev is None else f" ({prev - n:,} removed)"
    match st.kind:
        case "from":
            verb = "Read" if st.symbol == "R" else "Combine"
            return f"{verb} {st.clause}: {_plural(n, 'row')}"
        case "where":
            return f"Keep rows where {st.clause}: {_plural(n, 'row')}{removed}"
        case "group_by":
            return f"Group into {_plural(n, 'group')} by {st.clause}"
        case "having":
            return f"Keep groups where {st.clause}: {_plural(n, 'group')}{removed}"
        case "select":
            return f"Compute the output columns: {_plural(n, 'row')}"
        case "distinct":
            return f"Remove duplicate rows: {_plural(n, 'row')}{removed}"
        case _:
            return f"{st.clause}: {_plural(n, 'row')}"


_FILTERS = {("from", "where"), ("group_by", "having"), ("select", "distinct")}


def run_stages(ws_id: int, sql_text: str) -> list[StageOut]:
    """Run every stage as the workspace role: up to 50 sample rows, and the full count when there are more.

    Raises sandbox.QueryError from the first stage that fails (its position refers to the stage SQL, not the
    user's text, so it is dropped).
    """
    out: list[StageOut] = []
    for st in build_stages(sql_text):
        try:
            res = sandbox.run(ws_id, st.sql, max_rows=SAMPLE_ROWS)
            n, duration = res.row_count, res.duration_ms
            if res.truncated:
                counted = sandbox.run(ws_id, f"SELECT count(*) FROM ({st.sql}) AS s", max_rows=1)
                n, duration = int(counted.rows[0][0]), counted.duration_ms  # the count evaluates the whole stage
        except sandbox.QueryError as e:
            e.position = None
            raise
        # "removed" compares like with like: rows with rows, groups with groups.
        prev = out[-1].row_count if out and (out[-1].kind, st.kind) in _FILTERS else None
        out.append(StageOut(kind=st.kind, title=st.title, symbol=st.symbol, caption=_caption(st, n, prev),
                            sql=st.sql, row_count=n, columns=res.columns, rows=res.rows, duration_ms=duration))
    return out
