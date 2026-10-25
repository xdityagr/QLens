import { History, Plus } from "lucide-react"
import { useState, type ReactNode } from "react"
import { IconButton } from "../../components/Button"
import { Spinner } from "../../components/Spinner"
import { fmtRelative } from "../../lib/format"
import type { LaneOf } from "./Markdown"
import { AssistantTurn, ThinkingTurn, UserTurn, type SqlAction } from "./Thread"
import { useConversations, type Assistant } from "./useAssistant"

/** Earlier conversations of this screen and New chat: the controls above a thread (sidebar or page). */
export function ConversationControls({ a, wsId, children }: { a: Assistant; wsId: number; children?: ReactNode }) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const conversations = useConversations(wsId, a.context, historyOpen)
  return (
    <div
      className="relative flex items-center gap-1"
      // Esc closes the menu first; whoever holds the controls decides what a second Esc does
      onKeyDown={(e) => {
        if (e.key === "Escape" && historyOpen) {
          e.preventDefault()
          setHistoryOpen(false)
        }
      }}
    >
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
      {children}

      {historyOpen && (
        <div
          role="menu"
          className="as-menu absolute right-0 top-10 z-10 w-[min(340px,calc(100vw-1rem))] overflow-hidden rounded-card border border-border-strong bg-raised shadow-[var(--shadow-pop)]"
        >
          <div className="scrollbar-thin max-h-[360px] overflow-y-auto p-1">
            {conversations.isPending && (
              <div className="grid h-16 place-items-center text-muted">
                <Spinner size={15} />
              </div>
            )}
            {conversations.error && <p className="px-3 py-3 text-[13px] text-danger">{conversations.error.message}</p>}
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
    </div>
  )
}

/** The turns of a thread, the thinking placeholder, or `empty` when nothing has been asked yet. */
export function ThreadBody({
  a,
  laneOf,
  sqlAction,
  empty,
}: {
  a: Assistant
  laneOf: LaneOf
  sqlAction: SqlAction | null
  empty: ReactNode
}) {
  const lastError = [...a.turns].reverse().find((t) => t.role === "assistant")?.error
  if (a.loading)
    return (
      <div className="grid h-24 place-items-center text-muted">
        <Spinner size={16} />
      </div>
    )
  if (a.turns.length === 0 && a.pending === null) return <>{empty}</>
  return (
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
  )
}
