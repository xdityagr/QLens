// Moving a diagram from one layout to the next. React Flow places nodes with a CSS transform built
// from `position`, so stepping positions per frame animates with transforms only (no reflow).
// The pure parts (easing, matching, one frame) are tested; animateLayout drives them with rAF.

export type XY = { x: number; y: number }
type Positioned = { id: string; position: XY }

export function easeInOutCubic(t: number): number {
  const u = Math.min(1, Math.max(0, t))
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2
}

/**
 * Where each next node starts: the previous node with the same id, else (when `alias` is given) an
 * unclaimed previous node with the same alias, e.g. a table name after a rebuild gave it a new id.
 * Nodes with no match are new and have no start.
 */
export function startPositions<N extends Positioned>(prev: N[], next: N[], alias?: (n: N) => string): Map<string, XY> {
  const out = new Map<string, XY>()
  const prevById = new Map(prev.map((n) => [n.id, n]))
  const claimed = new Set<string>()
  for (const n of next) {
    const p = prevById.get(n.id)
    if (p) {
      out.set(n.id, { ...p.position })
      claimed.add(p.id)
    }
  }
  if (alias) {
    const prevByAlias = new Map<string, N>()
    for (const p of prev) if (!claimed.has(p.id) && !prevByAlias.has(alias(p))) prevByAlias.set(alias(p), p)
    for (const n of next) {
      if (out.has(n.id)) continue
      const p = prevByAlias.get(alias(n))
      if (p) {
        out.set(n.id, { ...p.position })
        prevByAlias.delete(alias(n))
      }
    }
  }
  return out
}

/** One frame at progress t (0..1, eased here): nodes with a start glide from it; the rest sit at their target. */
export function interpolateLayout<N extends Positioned>(from: Map<string, XY>, next: N[], t: number): N[] {
  const k = easeInOutCubic(t)
  return next.map((n) => {
    const s = from.get(n.id)
    if (!s) return n
    return { ...n, position: { x: s.x + (n.position.x - s.x) * k, y: s.y + (n.position.y - s.y) * k } }
  })
}

export interface AnimateLayoutOptions<N> {
  duration?: number
  /** skip straight to the end (prefers-reduced-motion) */
  reduced?: boolean
  alias?: (n: N) => string
  onFrame: (nodes: N[]) => void
  onDone?: () => void
}

/**
 * Glide `prevNodes` into `nextNodes`, calling onFrame with each frame's nodes. Returns a cancel
 * function; cancelling leaves the nodes wherever the last frame put them.
 */
export function animateLayout<N extends Positioned>(
  prevNodes: N[],
  nextNodes: N[],
  { duration = 420, reduced = false, alias, onFrame, onDone }: AnimateLayoutOptions<N>,
): () => void {
  const from = startPositions(prevNodes, nextNodes, alias)
  const moves = nextNodes.some((n) => {
    const s = from.get(n.id)
    return s && (Math.abs(s.x - n.position.x) > 0.5 || Math.abs(s.y - n.position.y) > 0.5)
  })
  if (reduced || !moves || typeof requestAnimationFrame === "undefined") {
    onFrame(nextNodes)
    onDone?.()
    return () => {}
  }
  let raf = 0
  let start: number | null = null
  const tick = (now: number) => {
    start ??= now
    const t = Math.min(1, (now - start) / duration)
    onFrame(t < 1 ? interpolateLayout(from, nextNodes, t) : nextNodes)
    if (t < 1) raf = requestAnimationFrame(tick)
    else onDone?.()
  }
  onFrame(interpolateLayout(from, nextNodes, 0))
  raf = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(raf)
}
