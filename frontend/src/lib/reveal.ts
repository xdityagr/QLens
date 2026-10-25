import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react"

const RM_QUERY = "(prefers-reduced-motion: reduce)"

function subscribeRM(cb: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {}
  const mq = window.matchMedia(RM_QUERY)
  mq.addEventListener("change", cb)
  return () => mq.removeEventListener("change", cb)
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeRM,
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(RM_QUERY).matches : false),
    () => false,
  )
}

/** True once (or while, with once=false) the element is on screen. */
export function useInView<T extends Element>(
  opts: { once?: boolean; threshold?: number; rootMargin?: string } = {},
): [RefObject<T | null>, boolean] {
  const { once = true, threshold = 0.25, rootMargin = "0px" } = opts
  const ref = useRef<T>(null)
  // Without IntersectionObserver (old browsers, tests) everything counts as visible.
  const [inView, setInView] = useState(() => typeof IntersectionObserver === "undefined")
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === "undefined") return
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true)
          if (once) io.disconnect()
        } else if (!once) setInView(false)
      },
      { threshold, rootMargin },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [once, threshold, rootMargin])
  return [ref, inView]
}

/** Eases a number from 0 to `target` once `run` turns true. Reduced motion jumps straight to it. */
export function useCountUp(target: number, run = true, duration = 900): number {
  const reduced = useReducedMotion()
  const [value, setValue] = useState(0)
  const instant = reduced || target === 0
  useEffect(() => {
    if (!run || instant) return
    let raf = 0
    const start = performance.now()
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      setValue(target * eased)
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, run, duration, instant])
  return run && instant ? target : value
}
