import { ArrowUp } from "lucide-react"
import { useEffect, useId, useRef, useState, type CSSProperties, type RefObject } from "react"
import { Mark } from "../../components/Wordmark"
import { Spinner } from "../../components/Spinner"
import { useReducedMotion } from "../../lib/reveal"
import { FOCUS_HINT, useFocusHotkey } from "./hotkey"

const CYCLE_MS = 3800

export interface CommandBarProps {
  /** float: the pill on the canvas; inline: in the page flow (Query); docked: the sidebar's input */
  variant: "float" | "inline" | "docked"
  value: string
  onChange: (v: string) => void
  onSubmit: (text: string) => void
  /** the message being answered; the field shows it while the assistant works */
  pending: string | null
  /** example prompts that cycle through the empty field */
  examples: string[]
  /** one-click prompts, shown while the empty field has focus */
  suggestions?: string[]
  /** Ctrl/⌘K focuses this bar (give it to the one bar that is visible) */
  hotkey?: boolean
  inputRef?: RefObject<HTMLInputElement | null>
  label: string
  onEscape?: () => void
}

/** One input for both questions and changes; the server decides which it is. */
export function CommandBar({
  variant,
  value,
  onChange,
  onSubmit,
  pending,
  examples,
  suggestions = [],
  hotkey = false,
  inputRef,
  label,
  onEscape,
}: CommandBarProps) {
  const ownRef = useRef<HTMLInputElement>(null)
  const ref = inputRef ?? ownRef
  const reduced = useReducedMotion()
  const [focused, setFocused] = useState(false)
  const [tick, setTick] = useState(0)
  const hintId = useId()
  const busy = pending !== null
  const empty = value.length === 0

  useFocusHotkey(ref, hotkey)

  // cycle the example only while the field is empty and idle
  const cycling = !reduced && empty && !busy && examples.length > 1
  useEffect(() => {
    if (!cycling) return
    const t = setInterval(() => setTick((n) => n + 1), CYCLE_MS)
    return () => clearInterval(t)
  }, [cycling])
  const example = examples.length ? examples[tick % examples.length] : ""

  const submit = (text: string) => {
    if (busy || !text.trim()) return
    onSubmit(text)
  }

  const showChips = variant !== "docked" && focused && empty && !busy && suggestions.length > 0
  const chips = showChips && (
    <div
      className={
        "flex flex-wrap justify-center gap-1.5 " +
        // over the page, never pushing it down: above the floating pill, under the inline one
        (variant === "float"
          ? "absolute inset-x-0 bottom-full mb-2.5"
          : "absolute inset-x-0 top-full z-20 mt-2 !justify-start")
      }
    >
      {suggestions.map((s, i) => (
        <button
          key={s}
          type="button"
          className="as-chip as-glass h-8 rounded-full px-3 text-[12.5px] text-muted transition-colors duration-150 hover:text-text"
          style={{ "--i": i } as CSSProperties}
          // keep focus in the field so the chips don't vanish before the click lands
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => submit(s)}
        >
          {s}
        </button>
      ))}
    </div>
  )

  const compact = variant === "docked"
  return (
    <div className={"relative w-full " + (variant === "float" ? "max-w-[620px]" : "")}>
      {variant === "float" && chips}
      <form
        className={"as-bar flex items-center gap-2.5 " + (compact ? "h-11 pl-3 pr-1.5" : "h-[52px] pl-4 pr-2")}
        data-busy={busy}
        data-variant={variant}
        onSubmit={(e) => {
          e.preventDefault()
          submit(value)
        }}
        onClick={() => ref.current?.focus()}
      >
        <span className="shrink-0 opacity-90">
          <Mark size={compact ? 16 : 18} />
        </span>
        <div className="relative min-w-0 flex-1">
          <input
            ref={ref}
            value={value}
            maxLength={2000}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // the first Esc clears the field and stops there; an empty field lets it through
                if (value) {
                  e.preventDefault()
                  onChange("")
                } else onEscape?.()
              }
            }}
            aria-label={label}
            aria-describedby={hintId}
            autoComplete="off"
            spellCheck={false}
            className={"as-input w-full " + (compact ? "text-[13.5px]" : "text-[14.5px]")}
          />
          {/* the field's placeholder, drawn by hand so the examples can change smoothly */}
          {empty && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-nowrap"
            >
              {busy ? (
                <span className="as-pending-text truncate text-[14px] text-muted">{pending}</span>
              ) : (
                <span
                  key={tick}
                  className={"as-ph truncate text-faint " + (compact ? "text-[13.5px]" : "text-[14.5px]")}
                >
                  {compact ? "Ask a follow-up" : example}
                </span>
              )}
            </span>
          )}
          <span id={hintId} className="sr-only">
            Ask a question, or say what to change. Example: {examples[0]}
          </span>
        </div>
        {!busy && empty && !focused && !compact && (
          <kbd className="hidden h-6 shrink-0 items-center rounded-[5px] border border-border-strong px-1.5 font-mono text-[11px] text-faint sm:inline-flex">
            {FOCUS_HINT}
          </kbd>
        )}
        <button
          type="submit"
          aria-label={busy ? "Working" : "Send"}
          disabled={busy || !value.trim()}
          className={
            "relative shrink-0 rounded-full transition-[background-color,color,transform] duration-150 active:scale-90 " +
            (compact ? "size-8 " : "size-9 ") +
            (value.trim() && !busy ? "bg-accent text-on-accent" : "bg-hover text-muted disabled:cursor-default")
          }
        >
          <span className="as-send-layer" data-on={!busy}>
            <ArrowUp size={16} strokeWidth={2.2} />
          </span>
          <span className="as-send-layer" data-on={busy}>
            <Spinner size={15} />
          </span>
        </button>
        <span aria-hidden className="as-spectrum" />
      </form>
      {variant === "inline" && chips}
    </div>
  )
}
