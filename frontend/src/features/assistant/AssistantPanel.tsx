import { History, Plus, X } from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { IconButton } from "../../components/Button"
import { Spinner } from "../../components/Spinner"
import { fmtRelative } from "../../lib/format"
import type { LaneOf } from "./Markdown"
import { AssistantTurn, ThinkingTurn, UserTurn, type SqlAction } from "./Thread"
import { useConversations, type Assistant } from "./useAssistant"

/**
 * The conversation, sliding in from the right over the page (and over Design's side panel). It holds
 * the thread with its evidence, the history switcher, New chat, and the follow-up input (`footer`).
 */
export function AssistantPanel({
  a,
  wsId,
  laneOf,
  sqlAction,
  footer,
  intro,
}: {
  a: Assistant
  wsId: number
  laneOf: LaneOf
  sqlAction: SqlAction | null
  footer: ReactNode
  /** what an empty thread says */
  intro: string
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const conversations = useConversations(wsId, a.context, historyOpen)
  const firstUser = a.turns.find((t) => t.role === "user")?.text
  const title = firstUser ?? "New chat"

  // Esc closes (the history menu first)
  useEffect(() => {
    if (!a.open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      if (historyOpen) setHistoryOpen(false)
      else a.setOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [a, historyOpen])

  // Follow the thread while it grows, but only if the reader is already at the bottom.
  const atBottom = useRef(true)
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  })

  const lastError = [...a.turns].reverse().find((t) => t.role === "assistant")?.error

  return createPortal(
    <aside
      aria-label="Assistant"
      data-open={a.open}
      inert={!a.open}
      className="as-side fixed bottom-0 right-0 top-14 z-40 flex w-full flex-col border-l border-border bg-bg sm:w-[420px]"
    >
      <header className="relative flex h-12 shrink-0 items-center gap-1 border-b border-border pl-4 pr-1.5">
        <h2 className="mr-auto min-w-0 truncate text-[13.5px] font-medium text-text" title={title}>
          {title}
        </h2>
        <IconButton
          label="Earlier conversations"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((v) => !v)}
          className={historyOpen ? "bg-hover text-text" : ""}
        >
          <History size={15} strokeWidth={1.75} />
        </IconButton>
        <IconButton label="New chat" onClick={a.newChat} disabled={a.pending !== null}>
          <Plus size={16} strokeWidth={1.75} />
        </IconButton>
        <IconButton label="Close (Esc)" onClick={() => a.setOpen(false)}>
          <X size={16} strokeWidth={1.75} />
        </IconButton>

        {historyOpen && (
          <div
            role="menu"
            className="as-menu absolute right-2 top-11 z-10 w-[min(340px,calc(100vw-1rem))] overflow-hidden rounded-card border border-border-strong bg-raised shadow-[var(--shadow-pop)]"
          >
            <div className="scrollbar-thin max-h-[360px] overflow-y-auto p-1">
              {conversations.isPending && (
                <div className="grid h-16 place-items-center text-muted">
                  <Spinner size={15} />
                </div>
              )}
              {conversations.error && (
                <p className="px-3 py-3 text-[13px] text-danger">{conversations.error.message}</p>
              )}
              {conversations.data?.length === 0 && (
                <p className="px-3 py-3 text-[13px] text-muted">No earlier conversations on this screen.</p>
              )}
              {conversations.data?.map((c) => (
                <button
                  key={c.id}
                  role="menuitem"
                  type="button"
                  disabled={a.pending !== null}
                  onClick={() => {
                    setHistoryOpen(false)
                    void a.openConversation(c.id)
                  }}
                  className={
                    "flex w-full flex-col items-start gap-0.5 rounded-control px-3 py-2 text-left transition-colors duration-150 hover:bg-hover " +
                    (c.id === a.conversationId ? "bg-hover" : "")
                  }
                >
                  <span className="w-full truncate text-[13px] text-text">{c.title}</span>
                  <span className="text-[11.5px] text-faint">
                    {fmtRelative(c.updated_at)}, {c.message_count} {c.message_count === 1 ? "message" : "messages"}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </header>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }}
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-5"
      >
        {a.loading ? (
          <div className="grid h-24 place-items-center text-muted">
            <Spinner size={16} />
          </div>
        ) : a.turns.length === 0 && a.pending === null ? (
          <p className="max-w-[34ch] text-[13.5px] leading-relaxed text-muted">{intro}</p>
        ) : (
          <div className="flex flex-col gap-5">
            {a.turns.map((t) =>
              t.role === "user" ? (
                <UserTurn key={t.key} turn={t} />
              ) : (
                <AssistantTurn
                  key={t.key}
                  turn={t}
                  laneOf={laneOf}
                  sqlAction={sqlAction}
                  onSettle={a.settle}
                  onRetry={t.error && t.error === lastError && a.error ? a.retry : null}
                />
              ),
            )}
            {a.pending !== null && <ThinkingTurn />}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border p-3">{footer}</div>
    </aside>,
    document.body,
  )
}
