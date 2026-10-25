"""EXPLAIN (ANALYZE, BUFFERS) of a user's SELECT, flattened into a list of plan nodes the UI can draw as a tree."""
from typing import Literal

import psycopg
from psycopg.types.json import Jsonb
from pydantic import BaseModel

from qlens.query import sandbox
from qlens.query.validate import validate_select


class PlanNode(BaseModel):
    id: int                     # position in a depth-first walk; the root is 0
    parent_id: int | None
    depth: int
    node_type: str
    relation: str | None
    alias: str | None
    index_name: str | None
    filter: str | None
    index_cond: str | None
    join_type: str | None
    hash_cond: str | None
    est_rows: float
    actual_rows: float          # per loop, as EXPLAIN reports it
    loops: int
    total_ms: float             # Actual Total Time x Actual Loops: all the time spent in this node and below
    self_ms: float              # total_ms minus the children's total_ms, never below 0
    cost: float
    pct_of_total: float         # share of the summed self_ms


class PlanOut(BaseModel):
    planning_ms: float
    execution_ms: float
    nodes: list[PlanNode]
    plan: dict                  # the plan document as EXPLAIN (FORMAT JSON) returned it
    snapshot_id: int | None = None


def walk(doc: dict) -> list[tuple[dict, int | None, int]]:
    """(raw node, parent id, depth) in depth-first order; a node's id is its index in the list.

    Iterative: a deeply nested query must not exhaust the Python stack.
    """
    out: list[tuple[dict, int | None, int]] = []
    stack: list[tuple[dict, int | None, int]] = [(doc["Plan"], None, 0)]
    while stack:
        node, parent, depth = stack.pop()
        me = len(out)
        out.append((node, parent, depth))
        # Reversed, so the first child is visited first.
        stack.extend((child, me, depth + 1) for child in reversed(node.get("Plans") or []))
    return out


def parse_plan(doc: dict) -> PlanOut:
    raw = walk(doc)
    total = [float(n.get("Actual Total Time") or 0) * int(n.get("Actual Loops") or 0) for n, _, _ in raw]
    children_ms = [0.0] * len(raw)
    for i, (_, parent, _) in enumerate(raw):
        if parent is not None:
            children_ms[parent] += total[i]
    # Floored: parallel workers can make the children add up to more than the parent's wall time.
    self_ms = [max(0.0, t - c) for t, c in zip(total, children_ms)]
    summed = sum(self_ms)
    nodes = [PlanNode(
        id=i, parent_id=parent, depth=depth, node_type=n["Node Type"], relation=n.get("Relation Name"),
        alias=n.get("Alias"), index_name=n.get("Index Name"), filter=n.get("Filter"),
        index_cond=n.get("Index Cond"), join_type=n.get("Join Type"), hash_cond=n.get("Hash Cond"),
        est_rows=float(n.get("Plan Rows") or 0), actual_rows=float(n.get("Actual Rows") or 0),
        loops=int(n.get("Actual Loops") or 0), total_ms=total[i], self_ms=self_ms[i],
        cost=float(n.get("Total Cost") or 0),
        pct_of_total=round(self_ms[i] / summed * 100, 2) if summed else 0.0,
    ) for i, (n, parent, depth) in enumerate(raw)]
    return PlanOut(planning_ms=float(doc.get("Planning Time") or 0),
                   execution_ms=float(doc.get("Execution Time") or 0), nodes=nodes, plan=doc)


def explain(conn: psycopg.Connection, ws_id: int, sql_text: str, target: Literal["main", "lab"]) -> PlanOut:
    """Plan and run the query once as the workspace role, and keep the plan as a snapshot.

    Raises ApiError for a query the validator refuses and sandbox.QueryError for one the database refuses.
    """
    from qlens.perf.lab import ensure_lab  # lab imports this module

    sql_text = validate_select(sql_text)
    if target == "lab":
        ensure_lab(conn, ws_id)  # commits a lab it builds: the sandbox reads through its own connection
    [doc] = sandbox.explain_analyze(ws_id, sql_text, target=target)
    plan = parse_plan(doc)
    plan.snapshot_id = conn.execute(
        "INSERT INTO qlens.explain_snapshots (workspace_id, target, plan, planning_ms, execution_ms) "
        "VALUES (%s, %s, %s, %s, %s) RETURNING id",
        (ws_id, target, Jsonb(doc), plan.planning_ms, plan.execution_ms)).fetchone()["id"]
    return plan
