import dagre from "@dagrejs/dagre"
import type { Edge, Node } from "@xyflow/react"
import { fmtInt } from "./format"

// Mirrors backend/qlens/perf/explain.py (Task 15).

/** One step of an EXPLAIN (ANALYZE) plan, flattened depth-first; the root has id 0. */
export interface PlanNode {
  id: number
  parent_id: number | null
  depth: number
  node_type: string
  relation: string | null
  alias: string | null
  index_name: string | null
  filter: string | null
  index_cond: string | null
  join_type: string | null
  hash_cond: string | null
  est_rows: number
  /** per loop, as EXPLAIN reports it */
  actual_rows: number
  loops: number
  /** time in this step and everything below it */
  total_ms: number
  /** time in this step alone */
  self_ms: number
  cost: number
  /** this step's share of the summed self_ms, 0..100 */
  pct_of_total: number
}

export interface PlanOut {
  planning_ms: number
  execution_ms: number
  nodes: PlanNode[]
  /** the raw EXPLAIN (FORMAT JSON) document */
  plan: Record<string, unknown>
  snapshot_id: number | null
}

export interface PlanTreeNode {
  node: PlanNode
  children: PlanTreeNode[]
}

/** Nest the flat node list by parent_id. Children keep plan order (outer input first). */
export function toTree(nodes: PlanNode[]): PlanTreeNode {
  const byId = new Map<number, PlanTreeNode>()
  for (const n of [...nodes].sort((a, b) => a.id - b.id)) byId.set(n.id, { node: n, children: [] })
  let root: PlanTreeNode | null = null
  for (const t of byId.values()) {
    const parent = t.node.parent_id === null ? undefined : byId.get(t.node.parent_id)
    if (parent) parent.children.push(t)
    else if (t.node.parent_id === null && !root) root = t
  }
  if (!root) throw new Error("The plan has no root node.")
  return root
}

/** How hot a step is: its own time as a share of the slowest step's own time, 0..1. */
export function heat(node: Pick<PlanNode, "self_ms">, maxSelf: number): number {
  if (!(maxSelf > 0)) return 0
  return Math.min(1, Math.max(0, node.self_ms / maxSelf))
}

/** How far the planner's row estimate was off, as a factor (1 = spot on). Compared per loop, as EXPLAIN prints both. */
export function misestimate(node: { est_rows: number; actual_rows: number; loops?: number }): number {
  const est = node.est_rows
  const actual = node.actual_rows
  return Math.max(est, actual) / Math.max(1, Math.min(est, actual))
}

/** Estimates this far off are worth a warning. */
export const MISESTIMATE_WARN = 10

/** The table a step reads: its own relation, or for an index-only step the table that index belongs to. */
export function relationOf(node: PlanNode, tableOfIndex: Record<string, string>): string | null {
  if (node.relation) return node.relation
  if (node.index_name) return tableOfIndex[node.index_name] ?? null
  return null
}

// Plain-words meaning of each step, short enough to sit under its name ("Seq Scan — reads every row").
const MEANING: Record<string, string> = {
  "Seq Scan": "reads every row",
  "Parallel Seq Scan": "several workers read every row",
  "Index Scan": "jumps straight to matching rows",
  "Index Only Scan": "answers from the index alone",
  "Bitmap Index Scan": "finds matching rows in the index",
  "Bitmap Heap Scan": "fetches the rows the index found",
  "Hash Join": "matches rows through a hash table",
  Hash: "builds a hash table from these rows",
  "Nested Loop": "for each row, looks up its matches",
  "Merge Join": "joins two sorted lists",
  Sort: "puts rows in order",
  "Incremental Sort": "puts rows in order, group by group",
  Aggregate: "adds rows up",
  HashAggregate: "groups rows with a hash table",
  GroupAggregate: "groups rows that arrive sorted",
  Limit: "stops after enough rows",
  Gather: "collects rows from parallel workers",
  "Gather Merge": "collects sorted rows from parallel workers",
  Materialize: "keeps rows in memory to reuse",
  Memoize: "remembers lookups it already did",
  Unique: "drops duplicate rows",
  Append: "puts several inputs one after another",
  Result: "computes values",
  "Subquery Scan": "reads a subquery's rows",
  "CTE Scan": "reads a WITH query's rows",
  "Function Scan": "reads a function's rows",
  "Values Scan": "reads a VALUES list",
  WindowAgg: "computes window functions",
  SetOp: "combines two result sets",
}

export function describeNode(nodeType: string): string {
  return MEANING[nodeType] ?? ""
}

/** The column an index condition looks up: "(student_id = 5)" -> "student_id". Null when it can't tell. */
export function indexColumn(cond: string | null): string | null {
  if (!cond) return null
  const m = /(?:\w+\.)?("(?:[^"]|"")+"|[A-Za-z_]\w*)\)*(?:::[\w ]+?)?\)*\s*(?:=|<>|<=|>=|<|>|~~|IS\b)/.exec(cond)
  if (!m) return null
  const id = m[1]
  return id.startsWith('"') ? id.slice(1, -1).replace(/""/g, '"') : id
}

/** One plain sentence for a step: what it does, to which table. "Reads every row of fee_register". */
export function stepSentence(node: PlanNode, tableOfIndex: Record<string, string>): string {
  const table = relationOf(node, tableOfIndex) ?? "the table"
  const col = indexColumn(node.index_cond)
  const index = col ? `the index on ${col}` : node.index_name ? `the index ${node.index_name}` : "an index"
  switch (node.node_type) {
    case "Seq Scan":
      return `Reads every row of ${table}`
    case "Parallel Seq Scan":
      return `Reads every row of ${table}, split across workers`
    case "Index Scan":
      return `Uses ${index} to jump straight to matching rows of ${table}`
    case "Index Only Scan":
      return `Answers from ${index} alone, without reading ${table}`
    case "Bitmap Index Scan":
      return `Finds the matching rows in ${index}`
    case "Bitmap Heap Scan":
      return `Fetches those rows from ${table}`
    case "Hash Join":
      return "Joins the rows of both sides with a hash table"
    case "Hash":
      return "Builds a hash table from the rows below"
    case "Nested Loop":
      return "Joins by looking up the matches for each row"
    case "Merge Join":
      return "Joins two sorted lists of rows"
    case "Sort":
    case "Incremental Sort":
      return "Sorts the rows"
    case "Aggregate":
      return "Adds up the rows (count, sum, …)"
    case "HashAggregate":
    case "GroupAggregate":
      return "Groups the rows"
    case "Limit":
      return "Stops once it has enough rows"
    case "Gather":
    case "Gather Merge":
      return "Collects rows from parallel workers"
    case "Materialize":
      return "Keeps the rows in memory to reuse them"
    case "Memoize":
      return "Remembers lookups it has already done"
    case "Unique":
      return "Drops duplicate rows"
    case "Append":
      return "Puts several inputs one after another"
    case "Result":
      return "Computes the result"
    case "Subquery Scan":
      return "Reads the rows of a subquery"
    case "CTE Scan":
      return "Reads the rows of a WITH query"
    case "WindowAgg":
      return "Computes window functions"
    case "SetOp":
      return "Combines two result sets"
    default:
      return node.node_type
  }
}

type RawPlanNode = Record<string, unknown> & { Plans?: RawPlanNode[] }

/**
 * The advisor's suggestion in two plain sentences. The row counts come from the plan's own Seq Scan of the
 * table (rows it read = rows kept + rows its filter threw away); without one, the advisor's reason stands.
 */
export function suggestionText(
  s: { table: string; columns: string[]; reason: string },
  plan: PlanOut,
): { problem: string; fix: string } {
  const cols = s.columns.length === 1 ? s.columns[0] : `(${s.columns.join(", ")})`
  const fix = `An index on ${cols} would let PostgreSQL jump straight to them.`
  const stack: RawPlanNode[] = plan.plan.Plan ? [plan.plan.Plan as RawPlanNode] : []
  while (stack.length) {
    const n = stack.pop()!
    const kind = n["Node Type"]
    if ((kind === "Seq Scan" || kind === "Parallel Seq Scan") && n["Relation Name"] === s.table) {
      const loops = Number(n["Actual Loops"] ?? 1)
      const kept = Number(n["Actual Rows"] ?? 0) * loops
      const read = kept + Number(n["Rows Removed by Filter"] ?? 0) * loops
      return { problem: `This query reads all ${fmtInt(read)} rows of ${s.table} to find ${fmtInt(kept)}.`, fix }
    }
    stack.push(...(n.Plans ?? []))
  }
  return { problem: s.reason, fix }
}

// The lab's limits (backend/qlens/perf/lab.py) and the size that makes an index's effect plain to see.
const LAB_MAX_ROWS = 500_000
const LAB_MAX_FACTOR = 200
const TARGET_ROWS = 150_000

/** How many times to grow the lab so its biggest table has about 150,000 rows; null when no growing is needed. */
export function chooseScaleFactor(biggestRows: number): number | null {
  if (!(biggestRows > 0)) return null
  const f = Math.min(Math.floor(TARGET_ROWS / biggestRows), LAB_MAX_FACTOR, Math.floor(LAB_MAX_ROWS / biggestRows))
  return f >= 2 ? f : null
}

/** The condition worth showing on a step's card, with what it is. */
export function conditionOf(node: PlanNode): { label: string; text: string } | null {
  if (node.index_cond) return { label: "looks up", text: node.index_cond }
  if (node.hash_cond) return { label: "matches", text: node.hash_cond }
  if (node.filter) return { label: "keeps", text: node.filter }
  return null
}

/** "×37 faster", "×2.3 faster", "About the same" or "×2.0 slower". */
export function speedupLabel(speedup: number | null): string {
  if (speedup === null || !Number.isFinite(speedup) || speedup <= 0) return "No timing"
  if (speedup >= 1.1) return `×${speedup >= 10 ? Math.round(speedup) : speedup.toFixed(1)} faster`
  if (speedup > 1 / 1.1) return "About the same"
  const slower = 1 / speedup
  return `×${slower >= 10 ? Math.round(slower) : slower.toFixed(1)} slower`
}

// ---- layout ------------------------------------------------------------------------------------

// Card geometry; PlanNodeCard renders to these numbers so dagre's boxes match the real cards.
export const PLAN_NODE_W = 272
const BASE_H = 122
const RELATION_H = 22
const CONDITION_H = 18

export function nodeHeight(node: PlanNode): number {
  return BASE_H + (node.relation || node.index_name ? RELATION_H : 0) + (conditionOf(node) ? CONDITION_H : 0)
}

export type PlanNodeData = {
  node: PlanNode
  /** 0..1, see heat() */
  heat: number
  /** the step that took the most time of its own */
  hottest: boolean
  /** position in a level-by-level walk from the root; drives the grow-in stagger */
  order: number
  /** filled in by the screen: the table this step reads and its lane */
  relation?: string | null
  lane?: number | null
}
export type PlanFlowNode = Node<PlanNodeData, "plan">
export type PlanEdgeData = {
  /** rows the child passed up to its parent (every loop) */
  rows: number
  /** the child's entrance order: the edge draws in with it */
  order: number
}
export type PlanFlowEdge = Edge<PlanEdgeData, "plan">

export const planNodeId = (id: number) => `p-${id}`

/** React Flow nodes and edges for a plan tree, laid out top to bottom with the root on top. */
export function layoutPlan(tree: PlanTreeNode): { nodes: PlanFlowNode[]; edges: PlanFlowEdge[] } {
  // level-by-level walk: the entrance order, and a flat list to lay out
  const flat: PlanTreeNode[] = []
  const queue = [tree]
  while (queue.length) {
    const t = queue.shift()!
    flat.push(t)
    queue.push(...t.children)
  }
  const maxSelf = Math.max(0, ...flat.map((t) => t.node.self_ms))
  const hottestId = maxSelf > 0 ? flat.reduce((a, b) => (b.node.self_ms > a.node.self_ms ? b : a)).node.id : null

  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: "TB", nodesep: 28, ranksep: 54, marginx: 0, marginy: 0 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const t of flat) g.setNode(planNodeId(t.node.id), { width: PLAN_NODE_W, height: nodeHeight(t.node) })
  for (const t of flat) for (const c of t.children) g.setEdge(planNodeId(t.node.id), planNodeId(c.node.id))
  dagre.layout(g)

  const order = new Map(flat.map((t, i) => [t.node.id, i]))
  const nodes: PlanFlowNode[] = flat.map((t, i) => {
    const id = planNodeId(t.node.id)
    const p = g.node(id)
    const h = nodeHeight(t.node)
    return {
      id,
      type: "plan",
      position: { x: p.x - PLAN_NODE_W / 2, y: p.y - h / 2 },
      width: PLAN_NODE_W,
      height: h,
      data: { node: t.node, heat: heat(t.node, maxSelf), hottest: t.node.id === hottestId, order: i },
      draggable: false,
    }
  })
  const edges: PlanFlowEdge[] = flat.flatMap((t) =>
    t.children.map((c) => ({
      id: `e-${t.node.id}-${c.node.id}`,
      type: "plan" as const,
      source: planNodeId(t.node.id),
      target: planNodeId(c.node.id),
      data: { rows: Math.round(c.node.actual_rows * c.node.loops), order: order.get(c.node.id)! },
    })),
  )
  return { nodes, edges }
}
