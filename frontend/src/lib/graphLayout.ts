import dagre from "@dagrejs/dagre"
import type { Edge, Node } from "@xyflow/react"
import { laneVar } from "./lanes"
import type { TableOut } from "./types"

// Table node geometry. TableNode renders to these numbers, so dagre's boxes match the real cards.
export const ER_HEADER_H = 44
export const ER_ROW_H = 26
export const ER_PAD_Y = 8
const MIN_W = 208
const MAX_W = 340
// JetBrains Mono at 12.5px / 11px and Space Grotesk 600 at 15px, measured roughly.
const MONO_NAME = 7.6
const MONO_TYPE = 6.7
const UI_TITLE = 8.9

export type TableNodeData = { table: TableOut; order: number }
export type ErNode = Node<TableNodeData, "table">
export type FkEdgeData = {
  color: string
  order: number
  /** ms before the edge draws in, set by the diagram */ delay?: number
  /** table ids at either end, set by the diagram when node ids are kept stable across versions */
  sourceTable?: number
  targetTable?: number
}
export type ErEdge = Edge<FkEdgeData, "fk">

export const nodeId = (tableId: number) => `t-${tableId}`
export const columnHandle = (columnId: number) => `c-${columnId}`
export const PK_HANDLE = "pk"

export function nodeSize(t: TableOut): { width: number; height: number } {
  const unique = new Set(t.unique_keys.flat())
  // icon, name, UQ marker, type, with 8px gaps and the row's 30px of padding, plus a little slack
  const row = Math.max(
    0,
    ...t.columns.map(
      (c) =>
        13 +
        c.name.length * MONO_NAME +
        (unique.has(c.name) && c.role !== "pk" ? 24 : 0) +
        c.data_type.length * MONO_TYPE,
    ),
  )
  const title = t.name.length * UI_TITLE + 80
  const width = Math.round(Math.min(MAX_W, Math.max(MIN_W, row + 3 * 8 + 30 + 16, title + 32)))
  return { width, height: ER_HEADER_H + t.columns.length * ER_ROW_H + ER_PAD_Y * 2 }
}

/**
 * Places the proposed tables left to right: a referenced table sits left of the tables that point
 * at it, so the chain reads teachers → batches → students → fee_register and the fact table, which
 * holds one row per sheet row, ends up rightmost. One edge per foreign key, in the lane colour of
 * the table it points at (the same colour that table has everywhere else).
 */
export function layoutEr(tables: TableOut[]): { nodes: ErNode[]; edges: ErEdge[] } {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: "LR", nodesep: 48, ranksep: 80, marginx: 0, marginy: 0 })
  g.setDefaultEdgeLabel(() => ({}))
  const byId = new Map(tables.map((t) => [t.id, t]))
  const sizes = new Map(tables.map((t) => [t.id, nodeSize(t)]))
  for (const t of tables) g.setNode(nodeId(t.id), sizes.get(t.id)!)

  const fks = tables.flatMap((t) =>
    t.columns
      .filter((c) => c.role === "fk" && c.references_table_id !== null && byId.has(c.references_table_id))
      .map((c) => ({ table: t, column: c, ref: byId.get(c.references_table_id!)! })),
  )
  // dagre ranks along edge direction, so it is given referenced → referencing
  for (const fk of fks) g.setEdge(nodeId(fk.ref.id), nodeId(fk.table.id))
  dagre.layout(g)

  const place = new Map(
    tables.map((t) => {
      const n = g.node(nodeId(t.id))
      const { width, height } = sizes.get(t.id)!
      return [t.id, { x: n.x - width / 2, y: n.y - height / 2 }]
    }),
  )

  // A fact table can be ranked early when a longer chain of entities runs beside it; push it past them.
  const facts = tables.filter((t) => t.kind === "fact")
  const others = tables.filter((t) => t.kind !== "fact")
  if (facts.length && others.length) {
    const right = Math.max(...others.map((t) => place.get(t.id)!.x + sizes.get(t.id)!.width))
    for (const f of facts) {
      const p = place.get(f.id)!
      if (p.x <= right) p.x = right + 80
    }
  }

  const ordered = [...tables].sort((a, b) => {
    const pa = place.get(a.id)!
    const pb = place.get(b.id)!
    return pa.x - pb.x || pa.y - pb.y
  })
  const orderOf = new Map(ordered.map((t, i) => [t.id, i]))

  const nodes: ErNode[] = tables.map((t) => ({
    id: nodeId(t.id),
    type: "table",
    position: place.get(t.id)!,
    width: sizes.get(t.id)!.width,
    height: sizes.get(t.id)!.height,
    data: { table: t, order: orderOf.get(t.id)! },
  }))

  const edges: ErEdge[] = fks.map(({ table, column, ref }) => {
    const color = laneVar(ref.color_index)
    return {
      id: `fk-${column.id}`,
      type: "fk",
      source: nodeId(table.id),
      sourceHandle: columnHandle(column.id),
      target: nodeId(ref.id),
      targetHandle: PK_HANDLE,
      style: { stroke: color },
      data: { color, order: orderOf.get(table.id)! },
    }
  })

  return { nodes, edges }
}
