import { useRef, type KeyboardEvent, type ReactNode } from "react"

export interface TabItem<K extends string> {
  key: K
  label: ReactNode
}

/** Underline tabs with arrow-key navigation. Controlled. */
export function Tabs<K extends string>({
  items,
  value,
  onChange,
  className = "",
}: {
  items: TabItem<K>[]
  value: K
  onChange: (k: K) => void
  className?: string
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  function onKey(e: KeyboardEvent, i: number) {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0
    if (!d) return
    const n = (i + d + items.length) % items.length
    refs.current[n]?.focus()
    onChange(items[n].key)
  }
  return (
    <div role="tablist" className={`flex gap-5 border-b border-border ${className}`}>
      {items.map((t, i) => {
        const active = t.key === value
        return (
          <button
            key={t.key}
            ref={(el) => {
              refs.current[i] = el
            }}
            role="tab"
            type="button"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.key)}
            onKeyDown={(e) => onKey(e, i)}
            className={
              "-mb-px border-b-2 pb-2.5 pt-1 text-[14px] transition-colors " +
              (active ? "border-accent text-text" : "border-transparent text-muted hover:text-text")
            }
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}
