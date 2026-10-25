import { ArrowUp } from "lucide-react"
import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react"
import { Spinner } from "../../components/Spinner"
import { FOCUS_HINT, useFocusHotkey } from "./hotkey"

const MAX_HEIGHT = 220

/**
 * The Ask AI page's message box: multi-line, Enter sends, Shift+Enter starts a new line, Ctrl/⌘K focuses it.
 * While a question is being answered it can still be typed into, but not sent; the lanes run along its edge.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  pending,
  placeholder,
  label,
  inputRef,
  note,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: (text: string) => void
  /** the message being answered */
  pending: string | null
  placeholder: string
  label: string
  inputRef?: RefObject<HTMLTextAreaElement | null>
  /** one line under the box */
  note?: string
}) {
  const ownRef = useRef<HTMLTextAreaElement>(null)
  const ref = inputRef ?? ownRef
  const [focused, setFocused] = useState(false)
  const noteId = useId()
  const busy = pending !== null
  const canSend = !busy && value.trim().length > 0
  useFocusHotkey(ref, true)

  // grow with the text up to MAX_HEIGHT, then scroll inside
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [value, ref])

  const submit = () => {
    if (canSend) onSubmit(value)
  }

  return (
    <div className="w-full">
      <form
        className="as-bar flex items-end gap-2 py-2 pl-4 pr-2"
        data-variant="composer"
        data-busy={busy}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) ref.current?.focus()
        }}
      >
        <textarea
          ref={ref}
          rows={1}
          value={value}
          maxLength={2000}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter, and Enter while an IME is composing, stay in the field
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          aria-label={label}
          aria-describedby={note ? noteId : undefined}
          placeholder={busy ? "Answering… you can type the next question" : placeholder}
          autoComplete="off"
          spellCheck
          className="as-input scrollbar-thin min-h-[40px] flex-1 resize-none py-[9px] text-[15px] leading-[22px] placeholder:text-faint"
        />
        {!focused && !value && !busy && (
          <kbd className="mb-2 hidden h-6 shrink-0 items-center rounded-[5px] border border-border-strong px-1.5 font-mono text-[11px] text-faint sm:inline-flex">
            {FOCUS_HINT}
          </kbd>
        )}
        <button
          type="submit"
          aria-label={busy ? "Working" : "Send (Enter)"}
          disabled={!canSend}
          className={
            "relative mb-0.5 size-9 shrink-0 rounded-full transition-[background-color,color,transform] duration-150 active:scale-90 " +
            (canSend ? "bg-accent text-on-accent" : "bg-hover text-muted disabled:cursor-default")
          }
        >
          <span className="as-send-layer" data-on={!busy}>
            <ArrowUp size={17} strokeWidth={2.2} />
          </span>
          <span className="as-send-layer" data-on={busy}>
            <Spinner size={15} />
          </span>
        </button>
        <span aria-hidden className="as-spectrum" />
      </form>
      {note && (
        <p id={noteId} className="mt-2 px-2 text-center text-[11.5px] leading-snug text-faint">
          {note}
        </p>
      )}
    </div>
  )
}
