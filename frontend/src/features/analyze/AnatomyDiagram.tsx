import "@xyflow/react/dist/base.css"
import {
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { Anatomy, AnatomyColumn, AnatomyEdge, AnatomyJoin } from "../../lib/anatomy"
import { layoutAnatomy } from "../../lib/anatomyLayout"
import { fmtInt } from "../../lib/format"
import { laneAlpha, laneVar } from "../../lib/lanes"
import { ColumnCard, type CardState } from "./ColumnCard"

const PAD = 18
const STAGGER = 70 // ms between nodes in the entrance

type Pt = { x: number; y: number }
type ColumnData = { col: AnatomyColumn; state: CardState; delay: number; onSelect: (n: string) => void }
type JoinData = { join: AnatomyJoin; labels: string; state: CardState; delay: number }
type EdgeData = {
  edge: AnatomyEdge
  points: Pt[]
  label?: Pt
  delay: number
  draw: number
  state: "normal" | "related" | "dim"
  onActivate: (e: AnatomyEdge) => void
}
type ColumnNode = Node<ColumnData, "column">
type JoinNode = Node<JoinData, "join">
type DepEdge = Edge<EdgeData, "dep">

/**
 * The dependency diagram: dagre lays it out (left to right, or top to bottom on narrow screens)
 * and React Flow renders it as a fixed, fitted picture. Nodes pop in along the flow, then edges
 * draw from determinant to dependent.
 */
export default function AnatomyDiagram({
  anatomy,
  selected,
  onSelect,
  onEdgeActivate,
}: {
  anatomy: Anatomy
  selected: string | null
  onSelect: (name: string | null) => void
  onEdgeActivate: (e: AnatomyEdge) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const dir = width > 0 && width < 680 ? "TB" : "LR"
  const layout = useMemo(() => layoutAnatomy(anatomy, dir), [anatomy, dir])

  // Fit once, centred; the picture never pans or zooms under the reader.
  const maxH = dir === "LR" ? 470 : 760
  let zoom = width ? Math.min(1, (width - 2 * PAD) / Math.max(1, layout.width)) : 1
  if (layout.height * zoom + 2 * PAD > maxH) zoom = (maxH - 2 * PAD) / layout.height
  const height = Math.max(120, Math.round(layout.height * zoom + 2 * PAD))
  const viewport = { x: (width - layout.width * zoom) / 2, y: (height - layout.height * zoom) / 2, zoom }

  // The first layout plays the full entrance; later ones (derived toggle, resize) only redraw edges.
  const sig = useMemo(
    () => layout.edges.map((e) => e.id + e.points.map((p) => `${p.x | 0},${p.y | 0}`).join(";")).join("|"),
    [layout],
  )
  const [firstSig, setFirstSig] = useState<string | null>(null)
  if (width && firstSig === null) setFirstSig(sig)
  const entrance = firstSig === null || sig === firstSig

  // what a selection lights up: edges touching the column, and through join nodes, their whole fan
  const related = useMemo(() => {
    if (!selected) return null
    const edges = new Set<string>()
    const nodes = new Set<string>([selected])
    const touch = (id: string) => {
      for (const e of anatomy.edges) {
        if ((e.source === id || e.target === id) && !edges.has(e.id)) {
          edges.add(e.id)
          for (const n of [e.source, e.target]) {
            if (!nodes.has(n)) {
              nodes.add(n)
              if (n.startsWith("join:")) touch(n)
            }
          }
        }
      }
    }
    touch(selected)
    return { edges, nodes }
  }, [selected, anatomy.edges])

  const orderOf = new Map(layout.nodes.map((n) => [n.id, n.order]))
  const colOf = new Map(anatomy.columns.map((c) => [c.name, c]))
  const joinOf = new Map(anatomy.joins.map((j) => [j.id, j]))
  const nodeState = (id: string): CardState =>
    !related ? "normal" : id === selected ? "selected" : related.nodes.has(id) ? "related" : "dim"

  const nodes: (ColumnNode | JoinNode)[] = layout.nodes.map((n) => {
    const delay = entrance ? n.order * STAGGER : 0
    if (n.kind === "join") {
      const j = joinOf.get(n.id)!
      return {
        id: n.id,
        type: "join",
        position: { x: n.x, y: n.y },
        width: n.w,
        height: n.h,
        data: {
          join: j,
          labels: j.lhs.map((c) => colOf.get(c)?.label ?? c).join(" + "),
          state: nodeState(n.id),
          delay,
        },
      }
    }
    return {
      id: n.id,
      type: "column",
      position: { x: n.x, y: n.y },
      width: n.w,
      height: n.h,
      data: { col: colOf.get(n.id)!, state: nodeState(n.id), delay, onSelect: (c) => onSelect(c === selected ? null : c) },
    }
  })

  const edgeOf = new Map(anatomy.edges.map((e) => [e.id, e]))
  const edges: DepEdge[] = layout.edges.map((le) => {
    const e = edgeOf.get(le.id)!
    const after = Math.max(orderOf.get(e.source) ?? 0, orderOf.get(e.target) ?? 0)
    return {
      // a new layout remounts edges so they draw again along their new route
      id: `${le.id}@${hash(sig)}`,
      source: e.source,
      target: e.target,
      type: "dep",
      data: {
        edge: e,
        points: le.points,
        label: le.label,
        delay: entrance ? after * STAGGER + 140 : 120,
        draw: entrance ? 560 : 380,
        state: !related ? "normal" : related.edges.has(e.id) ? "related" : "dim",
        onActivate: onEdgeActivate,
      },
    }
  })

  return (
    <div ref={box} className="anatomy-flow relative w-full" style={{ height }}>
      {width > 0 && (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          viewport={viewport}
          onViewportChange={() => {}}
          onPaneClick={() => onSelect(null)}
          panOnDrag={false}
          panOnScroll={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
        />
      )}
    </div>
  )
}

function ColumnNodeView({ data }: NodeProps<ColumnNode>) {
  return (
    <div className="anat-node" style={{ animationDelay: `${data.delay}ms` }}>
      <HiddenHandles />
      <ColumnCard col={data.col} state={data.state} onClick={() => data.onSelect(data.col.name)} />
    </div>
  )
}

function JoinNodeView({ data }: NodeProps<JoinNode>) {
  const c = laneVar(data.join.lane)
  return (
    <div
      className="anat-node grid size-[14px] place-items-center rounded-full transition-opacity duration-200"
      title={`${data.labels} together`}
      style={{
        animationDelay: `${data.delay}ms`,
        background: "var(--bg)",
        boxShadow: `inset 0 0 0 1.75px ${c}, 0 0 0 4px ${laneAlpha(data.join.lane, 0.14)}`,
        opacity: data.state === "dim" ? 0.3 : 1,
      }}
    >
      <HiddenHandles />
      <span className="size-[5px] rounded-full" style={{ background: c }} />
    </div>
  )
}

// Edges are drawn from dagre's routes, but React Flow still wants a handle on each end.
function HiddenHandles() {
  const s = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0, left: "50%", top: "50%" }
  return (
    <>
      <Handle type="target" position={Position.Left} style={s} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={s} isConnectable={false} />
    </>
  )
}

function DepEdgeView({ id, data }: EdgeProps<DepEdge>) {
  if (!data || data.points.length < 2) return null
  const { edge, points, label, delay, draw, state, onActivate } = data
  const join = edge.kind === "join"
  const approx = edge.kind === "approx"
  const color = !edge.accepted ? "var(--faint)" : approx ? "var(--lane-3)" : laneVar(edge.lane)
  const dash = approx ? "5 4" : edge.derived ? "1.5 4.5" : undefined
  const { d, tip, angle } = smoothPath(points, join ? 0 : 6)
  const maskId = "m" + id.replace(/[^a-zA-Z0-9_-]/g, "_")
  const dim = state === "dim"
  const width = state === "related" ? 2.2 : 1.6

  return (
    <>
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x={-1e4} y={-1e4} width={2e4} height={2e4}>
          <path
            d={d}
            pathLength={1}
            fill="none"
            stroke="white"
            strokeWidth={20}
            strokeDasharray="1 1"
            style={{ animation: `draw ${draw}ms cubic-bezier(.3,.6,.2,1) ${delay}ms both` }}
          />
        </mask>
      </defs>
      <g
        mask={`url(#${maskId})`}
        style={{ opacity: dim ? 0.14 : edge.derived && edge.accepted ? 0.8 : 1, transition: "opacity 200ms" }}
      >
        <path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={width}
          strokeDasharray={dash}
          strokeLinecap={edge.derived ? "round" : "butt"}
          style={{ transition: "stroke-width 200ms" }}
        />
        {state === "related" && edge.accepted && (
          <path
            d={d}
            fill="none"
            stroke={color}
            strokeWidth={3.4}
            strokeLinecap="round"
            strokeDasharray="0.1 11.9"
            className="flow-dots"
            style={{ animation: "flow 900ms linear infinite" }}
          />
        )}
        {!join && (
          <path
            d={`M0,0 L-8,-4.2 L-6.4,0 L-8,4.2 Z`}
            fill={color}
            transform={`translate(${tip.x},${tip.y}) rotate(${angle})`}
          />
        )}
      </g>
      {/* generous invisible hit area; the visible line is thin */}
      <path
        d={d}
        fill="none"
        stroke="transparent"
        strokeWidth={14}
        className="cursor-pointer"
        style={{ pointerEvents: "stroke" }}
        onClick={() => onActivate(edge)}
      >
        <title>{edgeTitle(edge)}</title>
      </path>
      {label && (
        <EdgeLabelRenderer>
          <button
            type="button"
            onClick={() => onActivate(edge)}
            className="anat-label nodrag nopan absolute flex h-[22px] items-center gap-1 rounded-full border px-2 text-[11.5px] font-medium whitespace-nowrap transition-[opacity,transform] duration-200 hover:scale-[1.04] active:scale-[0.98]"
            style={{
              transform: `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)`,
              animationDelay: `${delay + draw * 0.6}ms`,
              pointerEvents: "all",
              opacity: dim ? 0.25 : 1,
              background: "var(--surface)",
              borderColor: edge.accepted ? "color-mix(in oklab, var(--lane-3) 45%, transparent)" : "var(--border-strong)",
              color: edge.accepted ? "var(--lane-3)" : "var(--faint)",
            }}
            title={edge.accepted ? "Show these rows in Issues" : "Rejected rule: show it in the rules list"}
          >
            except in <span className="num">{fmtInt(edge.violatingRows)}</span>{" "}
            {edge.violatingRows === 1 ? "row" : "rows"}
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

function edgeTitle(e: AnatomyEdge) {
  if (e.kind === "join") return "Part of a two-column determinant"
  const kind = e.kind === "approx" ? `Approximate, ${e.violatingRows} rows disagree` : "Exact"
  return `${kind}${e.derived ? ", derived" : ""}${e.accepted ? "" : ", rejected"}`
}

const NODE_TYPES = { column: ColumnNodeView, join: JoinNodeView }
const EDGE_TYPES = { dep: DepEdgeView }

/**
 * Catmull-Rom through dagre's route points as cubic Béziers. The end is pulled back by `inset`
 * so the arrowhead, not the line, meets the node.
 */
function smoothPath(raw: Pt[], inset: number): { d: string; tip: Pt; angle: number } {
  const pts = raw.map((p) => ({ ...p }))
  const n = pts.length
  const tip = pts[n - 1]
  const prev = pts[n - 2]
  const len = Math.hypot(tip.x - prev.x, tip.y - prev.y) || 1
  const ux = (tip.x - prev.x) / len
  const uy = (tip.y - prev.y) / len
  if (inset) pts[n - 1] = { x: tip.x - ux * inset, y: tip.y - uy * inset }
  let d = `M${pts[0].x},${pts[0].y}`
  let lastCp = pts[0]
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? p2
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 }
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 }
    d += ` C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`
    lastCp = c2
  }
  const end = pts[n - 1]
  const ax = end.x - lastCp.x
  const ay = end.y - lastCp.y
  const angle = (Math.atan2(ay || uy, ax || ux) * 180) / Math.PI
  return { d, tip, angle }
}

function hash(s: string) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
