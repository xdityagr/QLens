import { Undo2, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Spinner } from "../../components/Spinner"
import type { EditToast as Toast } from "./useAssistant"

const STAY_MS = 9000

/**
 * "2 changes · Undo" after an edit on the canvas. Undo asks the assistant to undo (its undo tool goes
 * back one design version), so the canvas animates back the same way. The toast stays while hovered.
 */
export function EditToast({
  toast,
  undoing,
  onUndo,
  onDetails,
  onClose,
}: {
  toast: Toast
  undoing: boolean
  onUndo: () => void
  onDetails: () => void
  onClose: () => void
}) {
  const [held, setHeld] = useState(false)
  const s = toast.summary
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    if (held || undoing) return
    const t = setTimeout(() => close.current(), STAY_MS)
    return () => clearTimeout(t)
  }, [held, undoing, toast.key])

  const line = s.lines.length > 1 ? `${s.lines[0]}, +${s.lines.length - 1} more` : s.lines[0]
  return (
    <div
      key={toast.key}
      role="status"
      className="as-toast as-glass flex h-11 max-w-full items-center gap-2.5 rounded-full pl-3 pr-1.5 shadow-[0_14px_34px_-16px_rgb(0_0_0/0.7)]"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden className="as-tick shrink-0">
        <circle cx="8" cy="8" r="7" fill="color-mix(in oklab, var(--lane-4) 16%, transparent)" />
        <path
          d="M4.8 8.3 7 10.4l4.2-4.6"
          stroke="var(--lane-4)"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={1}
        />
      </svg>
      <span className="shrink-0 text-[13.5px] font-medium text-text">{s.title}</span>
      {line && (
        <button
          type="button"
          onClick={onDetails}
          title="Show the conversation"
          className="hidden min-w-0 truncate text-[12.5px] text-muted underline-offset-2 hover:text-text hover:underline sm:block"
        >
          {line}
        </button>
      )}
      {s.undoable && (
        <button
          type="button"
          onClick={onUndo}
          disabled={undoing}
          className="ml-0.5 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-accent transition-colors duration-150 hover:bg-hover disabled:opacity-70"
        >
          {undoing ? <Spinner size={13} /> : <Undo2 size={14} strokeWidth={2} />}
          {undoing ? "Undoing" : "Undo"}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onClose}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors duration-150 hover:bg-hover hover:text-text"
      >
        <X size={14} strokeWidth={1.75} />
      </button>
    </div>
  )
}
