import { useCallback, useSyncExternalStore } from "react"

export type Theme = "light" | "dark"

const KEY = "qlens.theme"
const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === "light" || v === "dark" ? v : null
  } catch {
    return null
  }
}

function system(): Theme {
  return media?.matches ? "dark" : "light"
}

let current: Theme = stored() ?? system()
const listeners = new Set<() => void>()

function apply(t: Theme) {
  current = t
  document.documentElement.dataset.theme = t
  document.documentElement.style.colorScheme = t
  listeners.forEach((l) => l())
}

// Follow the OS until the person picks a theme explicitly.
media?.addEventListener("change", () => {
  if (!stored()) apply(system())
})

export function initTheme() {
  apply(current)
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void } {
  const theme = useSyncExternalStore(subscribe, () => current, () => current)
  const setTheme = useCallback((t: Theme) => {
    try {
      localStorage.setItem(KEY, t)
    } catch {
      // preference just won't persist
    }
    apply(t)
  }, [])
  return { theme, setTheme }
}
