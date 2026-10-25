import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { reconcilePresence, type Present } from "../../lib/presence"

const QUERY = "(prefers-reduced-motion: reduce)"

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(QUERY)
      m.addEventListener("change", cb)
      return () => m.removeEventListener("change", cb)
    },
    () => window.matchMedia(QUERY).matches,
    () => false,
  )
}

/** Eases from the previously shown number to `value`. Jumps straight there under reduced motion. */
export function useTweenedCount(value: number, duration = 420): number {
  const reduced = usePrefersReducedMotion()
  const [shown, setShown] = useState(value)
  const from = useRef(value)

  useEffect(() => {
    const start = from.current
    if (reduced || start === value) {
      from.current = value
      setShown(value)
      return
    }
    let raf = 0
    const t0 = performance.now()
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / duration)
      const v = Math.round(start + (value - start) * (1 - Math.pow(1 - k, 3)))
      from.current = v
      setShown(v)
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, duration, reduced])

  return shown
}

/**
 * Keeps removed items on screen for `exitMs` with `leaving: true`, so they can animate out
 * (opacity/transform only) instead of vanishing from under the pointer.
 */
export function usePresence<T>(items: T[], keyOf: (t: T) => string, exitMs = 260): Present<T>[] {
  const [shown, setShown] = useState<Present<T>[]>(() => reconcilePresence([], items, keyOf))
  const [prevItems, setPrevItems] = useState(items)
  // Adjust state while rendering (React's pattern for reacting to a prop change) so the exit starts
  // this frame. Compared shallowly, so a freshly filtered array with the same items doesn't loop.
  let current = shown
  if (items.length !== prevItems.length || items.some((t, i) => t !== prevItems[i])) {
    current = reconcilePresence(shown, items, keyOf)
    setPrevItems(items)
    setShown(current)
  }

  const leavingKeys = current
    .filter((p) => p.leaving)
    .map((p) => p.key)
    .join("\u0000")
  useEffect(() => {
    if (!leavingKeys) return
    const gone = new Set(leavingKeys.split("\u0000"))
    const t = setTimeout(() => setShown((s) => s.filter((p) => !(p.leaving && gone.has(p.key)))), exitMs)
    return () => clearTimeout(t)
  }, [leavingKeys, exitMs])

  return current
}
