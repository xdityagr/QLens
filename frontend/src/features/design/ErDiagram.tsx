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
  type EdgeProps,
  type FitViewOptions,
} from "@xyflow/react"
import { LayoutGrid, Maximize, Minus, Plus } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { IconButton } from "../../components/Button"
import { layoutEr, type ErEdge, type ErNode } from "../../lib/graphLayout"
import { animateLayout, type XY } from "../../lib/layoutMotion"
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

/**
 * The proposed schema as an ER diagram on a dot grid. Tables pop in left to right, then their
 * foreign keys draw. Tables can be dragged; a rename or rebuild glides every table the user hasn't
 * moved to its new place (animateLayout), and "Tidy up" puts everything back on the layout.
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
  const layout = useMemo(() => layoutEr(tables), [tables])
  const [nodes, setNodes, onNodesChange] = useNodesState<ErNode>([])
  const pinned = useRef(new Map<string, XY>())
  const cancel = useRef<() => void>(() => {})
  // the first layout plays the full entrance; edges that mount later draw on their own
  const [firstLayout] = useState(layout)

  // Each new layout: place tables (first time) or glide them from where they are now.
  useEffect(() => {
    const prev = rf.getNodes()
    const ids = new Set(layout.nodes.map((n) => n.id))
    const structural = prev.length !== ids.size || prev.some((n) => !ids.has(n.id))
    if (structural) pinned.current.clear()
    const prevNames = new Set(prev.map((n) => n.data.table.name))
    const prevIds = new Set(prev.map((n) => n.id))
    const target: ErNode[] = layout.nodes.map((n) => {
      const known = prevIds.has(n.id) || prevNames.has(n.data.table.name)
      return {
        ...n,
        position: pinned.current.get(n.id) ?? n.position,
        className: known ? undefined : "er-enter",
        style: known ? undefined : ({ "--er-order": n.data.order } as CSSProperties),
      }
    })
    cancel.current()
    cancel.current = animateLayout(prev, target, {
      reduced,
      alias: (n) => n.data.table.name,
      onFrame: (frame) =>
        setNodes((cur) => {
          // keep React Flow's own bookkeeping (measured size, dragging) on nodes it already knows
          const byId = new Map(cur.map((c) => [c.id, c]))
          return frame.map((n) => {
            const c = byId.get(n.id)
            return c ? { ...c, ...n } : n
          })
        }),
      onDone: () => {
        // refit after a rebuild, or when a rename pushed a table out of sight; otherwise leave the view alone
        if (prev.length && (structural || !allVisible())) void rf.fitView({ ...FIT, duration: reduced ? 0 : 450 })
      },
    })
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
  const sId = Number(source.slice(2))
  const tId = Number(target.slice(2))
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
