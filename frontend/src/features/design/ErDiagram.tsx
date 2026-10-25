import "@xyflow/react/dist/base.css"
import "./design.css"
import {
  Background,
  BackgroundVariant,
  getSmoothStepPath,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  useStoreApi,
  useUpdateNodeInternals,
  type EdgeProps,
  type FitViewOptions,
} from "@xyflow/react"
import { LayoutGrid, Maximize, Minus, Plus } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { IconButton } from "../../components/Button"
import { layoutEr, nodeId, type ErEdge, type ErNode } from "../../lib/graphLayout"
import { animateLayout, type XY } from "../../lib/layoutMotion"
import { diffProposals, stableIds } from "../../lib/proposalDiff"
import { useReducedMotion } from "../../lib/reveal"
import type { TableOut } from "../../lib/types"
import { useEr } from "./erContext"
import { TableNode } from "./TableNode"

const NODE_TYPES = { table: TableNode }
const EDGE_TYPES = { fk: FkEdge }
// room for the floating title (top), the controls and the command bar (bottom)
const FIT_WIDE: FitViewOptions = { padding: { top: "120px", bottom: "80px", x: "40px" }, maxZoom: 1.05, minZoom: 0.35 }
// On a phone the whole chain would shrink past reading size; keep it legible and let the reader pan.
const FIT_NARROW: FitViewOptions = { padding: { top: "150px", bottom: "72px", x: "16px" }, maxZoom: 1, minZoom: 0.62 }
const FIT = typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches ? FIT_NARROW : FIT_WIDE
const NODE_STAGGER = 90 // ms, matches design.css
const EDGE_STAGGER = 70
const EXIT_MS = 320 // matches .er-exit in design.css

/**
 * The proposed schema as an ER diagram on a dot grid. Tables pop in left to right, then their
 * foreign keys draw. Tables can be dragged; a rename or rebuild glides every table the user hasn't
 * moved to its new place (animateLayout), and "Tidy up" puts everything back on the layout.
 *
 * An assistant edit arrives as a new draft version whose tables all have new ids. Each table keeps
 * the node id it was shown under (stableIds pairs versions by the sheet columns a table holds), so a
 * renamed table glides and flashes instead of popping out and back in; new tables place in, removed
 * ones fade out, and edges follow their tables.
 */
export default function ErDiagram({ tables, children }: { tables: TableOut[]; children?: ReactNode }) {
  return (
    <ReactFlowProvider>
      <Canvas tables={tables}>{children}</Canvas>
    </ReactFlowProvider>
  )
}

function Canvas({ tables, children }: { tables: TableOut[]; children?: ReactNode }) {
  const reduced = useReducedMotion()
  const rf = useReactFlow<ErNode, ErEdge>()
  const store = useStoreApi<ErNode, ErEdge>()
  // what is on the canvas now: its tables and the node id each is shown under (committed in the effect)
  const shown = useRef<{ tables: TableOut[]; ids: Map<number, string> }>({ tables: [], ids: new Map() })
  const layout = useMemo(() => {
    const before = shown.current
    const ids = stableIds(before.tables, before.ids, tables)
    const diff = before.tables.length ? diffProposals(before.tables, tables) : null
    return { ...withNodeIds(layoutEr(tables), ids), ids, diff }
  }, [tables])
  const [nodes, setNodes, onNodesChange] = useNodesState<ErNode>([])
  const pinned = useRef(new Map<string, XY>())
  const cancel = useRef<() => void>(() => {})
  const flip = useRef(false)
  const updateInternals = useUpdateNodeInternals()
  // the first layout plays the full entrance; edges that mount later draw on their own
  const [firstLayout] = useState(layout)

  // Each new layout: place tables (first time) or glide them from where they are now.
  useEffect(() => {
    shown.current = { tables, ids: layout.ids }
    // ghosts of tables still fading out from the previous change are not part of the layout
    const prev = rf.getNodes().filter((n) => n.className !== "er-exit")
    const ids = new Set(layout.nodes.map((n) => n.id))
    const structural = prev.length !== ids.size || prev.some((n) => !ids.has(n.id))
    if (structural) pinned.current.clear()
    const prevIds = new Set(prev.map((n) => n.id))
    flip.current = !flip.current
    const changed = `er-changed ${flip.current ? "er-changed-a" : "er-changed-b"}`
    const target: ErNode[] = layout.nodes.map((n) => {
      const known = prevIds.has(n.id)
      const edited = known && layout.diff?.changedIds.has(n.data.table.id)
      return {
        ...n,
        position: pinned.current.get(n.id) ?? n.position,
        className: !known ? "er-enter" : edited ? changed : undefined,
        // a table placed in by an edit waits for the others to glide first
        style: known ? undefined : ({ "--er-order": prev.length ? 3 : n.data.order } as CSSProperties),
      }
    })
    // removed tables fade where they stood (reduced motion: they just go)
    const exiting: ErNode[] = reduced
      ? []
      : prev.filter((n) => !ids.has(n.id)).map((n) => ({ ...n, className: "er-exit", draggable: false }))
    let exitDone = exiting.length === 0
    const exitTimer = exitDone
      ? undefined
      : setTimeout(() => {
          exitDone = true
          setNodes((cur) => cur.filter((n) => n.className !== "er-exit"))
        }, EXIT_MS)
    cancel.current()
    const stop = animateLayout(prev, target, {
      reduced,
      onFrame: (frame) =>
        setNodes((cur) => {
          // keep React Flow's own bookkeeping (measured size, dragging) on nodes it already knows
          const byId = new Map(cur.map((c) => [c.id, c]))
          const next = frame.map((n) => {
            const c = byId.get(n.id)
            return c ? { ...c, ...n } : n
          })
          return exitDone ? next : [...next, ...exiting]
        }),
      onDone: () => {
        // refit after a rebuild, or when a rename pushed a table out of sight; otherwise leave the view alone
        if (prev.length && (structural || !allVisible())) void rf.fitView({ ...FIT, duration: reduced ? 0 : 450 })
      },
    })
    // A kept node whose table is a new version has new column ids, so new handle ids: React Flow
    // must re-measure its handles or the edges into it can't find their ends.
    const remeasure = requestAnimationFrame(() => updateInternals(layout.nodes.map((n) => n.id)))
    cancel.current = () => {
      stop()
      clearTimeout(exitTimer)
      cancelAnimationFrame(remeasure)
    }
    return () => cancel.current()
    // `reduced` only matters at the moment a layout starts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout])

  const edges: ErEdge[] = useMemo(() => {
    const entrance = layout === firstLayout
    const after = layout.nodes.length * NODE_STAGGER + 260
    return layout.edges.map((e) => ({
      ...e,
      data: { ...e.data!, delay: entrance ? after + e.data!.order * EDGE_STAGGER : 220 },
    }))
  }, [layout, firstLayout])

  function allVisible(): boolean {
    const { width, height, transform } = store.getState()
    const [vx, vy, zoom] = transform
    return rf.getNodes().every((n) => {
      const w = n.measured?.width ?? n.width ?? 0
      const h = n.measured?.height ?? n.height ?? 0
      const x = n.position.x * zoom + vx
      const y = n.position.y * zoom + vy
      return x >= 0 && y >= 0 && x + w * zoom <= width && y + h * zoom <= height
    })
  }

  function tidy() {
    pinned.current.clear()
    cancel.current()
    cancel.current = animateLayout(rf.getNodes(), layout.nodes, {
      reduced,
      onFrame: (frame) =>
        setNodes((cur) => {
          const byId = new Map(frame.map((f) => [f.id, f.position]))
          return cur.map((c) => ({ ...c, position: byId.get(c.id) ?? c.position }))
        }),
      onDone: () => void rf.fitView({ ...FIT, duration: reduced ? 0 : 450 }),
    })
  }

  return (
    <ReactFlow
      className="er-flow"
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      onNodeDragStart={() => cancel.current()}
      onNodeDragStop={(_e, node) => pinned.current.set(node.id, node.position)}
      fitView
      fitViewOptions={FIT}
      minZoom={0.3}
      maxZoom={1.75}
      zoomOnDoubleClick={false}
      nodesConnectable={false}
      elementsSelectable={false}
      edgesFocusable={false}
      deleteKeyCode={null}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="var(--er-dot)" />
      <Panel position="bottom-left" className="!m-4">
        <div className="flex flex-col rounded-control border border-border-strong bg-[var(--er-card)] p-0.5 shadow-[var(--shadow-pop)]">
          <IconButton label="Zoom in" onClick={() => void rf.zoomIn({ duration: reduced ? 0 : 200 })}>
            <Plus size={15} strokeWidth={1.75} />
          </IconButton>
          <IconButton label="Zoom out" onClick={() => void rf.zoomOut({ duration: reduced ? 0 : 200 })}>
            <Minus size={15} strokeWidth={1.75} />
          </IconButton>
          <IconButton label="Fit to screen" onClick={() => void rf.fitView({ ...FIT, duration: reduced ? 0 : 400 })}>
            <Maximize size={14} strokeWidth={1.75} />
          </IconButton>
          <span aria-hidden className="mx-1.5 my-0.5 h-px bg-border" />
          <IconButton label="Tidy up: put every table back on the layout" onClick={tidy}>
            <LayoutGrid size={14} strokeWidth={1.75} />
          </IconButton>
        </div>
      </Panel>
      {children}
    </ReactFlow>
  )
}

/** A foreign key: from the fk column (hollow end) to the referenced table's id (filled end). */
function FkEdge({
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<ErEdge>) {
  const er = useEr()
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 14,
    offset: 22,
  })
  const color = data?.color ?? "var(--muted)"
  const delay = data?.delay ?? 0
  const sId = data?.sourceTable ?? Number(source.slice(2))
  const tId = data?.targetTable ?? Number(target.slice(2))
  // the caps sit just outside the cards (handles are on the card edge, under the node layer)
  const out = (pos: typeof sourcePosition) => (pos === "left" ? -4 : pos === "right" ? 4 : 0)
  const focus = er.hovered !== null
  const lit = !focus || er.hovered === sId || er.hovered === tId

  return (
    <g className="er-edge" style={{ opacity: lit ? 1 : 0.16 }}>
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={focus && lit ? 2.1 : 1.5}
        pathLength={1}
        className="er-edge-line"
        style={{ animationDelay: `${delay}ms`, transition: "stroke-width 160ms ease" }}
      />
      <circle
        cx={sourceX + out(sourcePosition)}
        cy={sourceY}
        r={3.2}
        fill="var(--bg)"
        stroke={color}
        strokeWidth={1.5}
        className="er-edge-cap"
        style={{ animationDelay: `${delay}ms` }}
      />
      <circle
        cx={targetX + out(targetPosition)}
        cy={targetY}
        r={3.2}
        fill={color}
        className="er-edge-cap"
        style={{ animationDelay: `${delay + 480}ms` }}
      />
    </g>
  )
}

/**
 * The layout with each table under its stable node id. Edges are keyed by the tables they join, so an
 * edge between the same two tables stays mounted (and re-routes) across versions instead of redrawing.
 */
function withNodeIds(base: { nodes: ErNode[]; edges: ErEdge[] }, ids: Map<number, string>) {
  const byNode = new Map<string, { id: string; table: number }>()
  for (const [table, id] of ids) byNode.set(nodeId(table), { id, table })
  const seen = new Map<string, number>()
  const edges: ErEdge[] = base.edges.map((e) => {
    const s = byNode.get(e.source)
    const t = byNode.get(e.target)
    const source = s?.id ?? e.source
    const target = t?.id ?? e.target
    const key = `${source}>${target}`
    const n = seen.get(key) ?? 0
    seen.set(key, n + 1)
    return {
      ...e,
      id: `fk:${key}:${n}`,
      source,
      target,
      data: { ...e.data!, sourceTable: s?.table, targetTable: t?.table },
    }
  })
  const nodes = base.nodes.map((n) => ({ ...n, id: ids.get(n.data.table.id) ?? n.id }))
  return { nodes, edges }
}
