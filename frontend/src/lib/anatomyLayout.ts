import dagre from "@dagrejs/dagre"
import type { Anatomy } from "./anatomy"

// Kept apart from anatomy.ts so dagre only loads with the (lazy) diagram.

export const NODE_W = 172
export const NODE_H = 54
export const JOIN_SIZE = 14
/** room dagre keeps on an approximate edge for its "except in N rows" pill */
const LABEL_W = 116
const LABEL_H = 22

export type Direction = "LR" | "TB"

export interface PlacedNode {
  id: string
  kind: "column" | "join"
  /** top-left corner */
  x: number
  y: number
  w: number
  h: number
  /** entrance order: along the flow first, then across it */
  order: number
}

export interface PlacedEdge {
  id: string
  points: { x: number; y: number }[]
  label?: { x: number; y: number }
}

export interface AnatomyLayout {
  nodes: PlacedNode[]
  edges: PlacedEdge[]
  width: number
  height: number
}

export function layoutAnatomy(g: Anatomy, dir: Direction): AnatomyLayout {
  const d = new dagre.graphlib.Graph({ multigraph: true })
  d.setGraph({
    rankdir: dir,
    nodesep: dir === "LR" ? 22 : 18,
    ranksep: dir === "LR" ? 44 : 40,
    edgesep: 14,
    marginx: 4,
    marginy: 4,
  })
  d.setDefaultEdgeLabel(() => ({}))
  for (const c of g.columns) d.setNode(c.name, { width: NODE_W, height: NODE_H })
  for (const j of g.joins) d.setNode(j.id, { width: JOIN_SIZE, height: JOIN_SIZE })
  for (const e of g.edges) {
    const labelled = e.kind === "approx"
    d.setEdge(
      e.source,
      e.target,
      labelled ? { width: LABEL_W, height: LABEL_H, labelpos: "c" } : { width: 0, height: 0 },
      e.id,
    )
  }
  dagre.layout(d)

  const along = (p: { x: number; y: number }) => (dir === "LR" ? [p.x, p.y] : [p.y, p.x])
  const joinIds = new Set(g.joins.map((j) => j.id))
  const placed = d.nodes().map((id) => {
    const n = d.node(id)
    return { id, kind: joinIds.has(id) ? ("join" as const) : ("column" as const), cx: n.x, cy: n.y, w: n.width, h: n.height }
  })
  const sorted = [...placed].sort((p, q) => {
    const [a1, a2] = along({ x: p.cx, y: p.cy })
    const [b1, b2] = along({ x: q.cx, y: q.cy })
    return a1 - b1 || a2 - b2
  })
  const orderOf = new Map(sorted.map((p, i) => [p.id, i]))
  const nodes: PlacedNode[] = placed.map((p) => ({
    id: p.id,
    kind: p.kind,
    x: p.cx - p.w / 2,
    y: p.cy - p.h / 2,
    w: p.w,
    h: p.h,
    order: orderOf.get(p.id)!,
  }))

  const edges: PlacedEdge[] = g.edges.map((e) => {
    const de = d.edge({ v: e.source, w: e.target, name: e.id })
    const points = (de.points ?? []).map((p: { x: number; y: number }) => ({ x: p.x, y: p.y }))
    return e.kind === "approx" && de.x !== undefined ? { id: e.id, points, label: { x: de.x, y: de.y } } : { id: e.id, points }
  })

  const gl = d.graph()
  return { nodes, edges, width: gl.width ?? 0, height: gl.height ?? 0 }
}
