import { X } from "lucide-react"
import { useLayoutEffect, useRef, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { IconButton } from "../../components/Button"
import type { LaneOf } from "./Markdown"
import { ConversationControls, ThreadBody } from "./Conversation"
import type { SqlAction } from "./Thread"
import type { Assistant } from "./useAssistant"

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
  const firstUser = a.turns.find((t) => t.role === "user")?.text
  const title = firstUser ?? "New chat"

  // Follow the thread while it grows, but only if the reader is already at the bottom.
  const atBottom = useRef(true)
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  })

  return createPortal(
    <aside
      aria-label="Assistant"
      data-open={a.open}
      inert={!a.open}
      // Esc inside the sidebar closes the history menu (ConversationControls), then the sidebar. Only here:
      // Esc in the editor, a dialog or elsewhere on the page is not ours, and a field that used Esc itself
      // prevents default.
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return
        e.preventDefault()
        a.setOpen(false)
      }}
      className="as-side fixed bottom-0 right-0 top-14 z-40 flex w-full flex-col border-l border-border bg-bg sm:w-[420px]"
    >
      <header className="relative flex h-12 shrink-0 items-center gap-1 border-b border-border pl-4 pr-1.5">
        <h2 className="mr-auto min-w-0 truncate text-[13.5px] font-medium text-text" title={title}>
          {title}
        </h2>
        <ConversationControls a={a} wsId={wsId}>
          <IconButton label="Close (Esc)" onClick={() => a.setOpen(false)}>
            <X size={16} strokeWidth={1.75} />
          </IconButton>
        </ConversationControls>
      </header>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }}
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-5"
      >
        <ThreadBody
          a={a}
          laneOf={laneOf}
          sqlAction={sqlAction}
          empty={<p className="max-w-[34ch] text-[13.5px] leading-relaxed text-muted">{intro}</p>}
        />
      </div>

      <div className="shrink-0 border-t border-border p-3">{footer}</div>
    </aside>,
    document.body,
  )
}
