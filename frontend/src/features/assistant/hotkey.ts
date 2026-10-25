import { useEffect, type RefObject } from "react"

export const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
export const FOCUS_HINT = isMac ? "⌘K" : "Ctrl K"

/**
 * ⌘K on a Mac, Ctrl+K elsewhere (Ctrl+K on a Mac is the editor's kill-line) focuses `ref` and selects its text.
 * Give it to the one field on screen that should answer it.
 */
export function useFocusHotkey(ref: RefObject<HTMLInputElement | HTMLTextAreaElement | null>, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      if (mod && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault()
        ref.current?.focus()
        ref.current?.select()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [enabled, ref])
}
