import { MessageSquareText } from "lucide-react"
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react"
import { useReducedMotion } from "../../lib/reveal"
import { ConversationControls, ThreadBody } from "./Conversation"
import type { LaneOf } from "./Markdown"
import type { SqlAction } from "./Thread"
import type { Assistant } from "./useAssistant"

/**
 * The conversation laid out in the page itself (the Data page's Ask AI tab), full width: the thread with each
 * answer, its result table and SQL, then the input. An empty thread offers starter questions for these tables.
 */
export function AssistantPage({
  a,
  wsId,
  laneOf,
  sqlAction,
  intro,
  starters,
  input,
}: {
  a: Assistant
  wsId: number
  laneOf: LaneOf
  sqlAction: SqlAction | null
  intro: string
  /** questions to start from, asked with one click */
  starters: string[]
  /** the question bar */
  input: ReactNode
}) {
  const reduced = useReducedMotion()
  const end = useRef<HTMLDivElement>(null)
  const count = a.turns.length + (a.pending !== null ? 1 : 0)
  // a new question or answer: bring the bottom of the thread (and the input) into view
  useEffect(() => {
    if (count > 0) end.current?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" })
  }, [count, reduced])

  const firstUser = a.turns.find((t) => t.role === "user")?.text

  return (
    <section aria-label="Ask about your data" className="flex min-w-0 flex-col gap-5">
      <header className="flex items-center gap-3 border-b border-border pb-3">
        <MessageSquareText size={16} strokeWidth={1.75} className="shrink-0 text-muted" aria-hidden />
        <h3 className="mr-auto min-w-0 truncate text-[15px] font-medium text-text" title={firstUser}>
          {firstUser ?? "New conversation"}
        </h3>
        <ConversationControls a={a} wsId={wsId} />
      </header>

      <div>
        <ThreadBody
          a={a}
          laneOf={laneOf}
          sqlAction={sqlAction}
          empty={
            <div className="flex flex-col gap-4">
              <p className="max-w-[66ch] text-[14px] leading-relaxed text-muted">{intro}</p>
              {starters.length > 0 && (
                <div>
                  <p className="mb-2 text-[13px] text-text">Start with a question about your tables</p>
                  <ul className="flex flex-wrap gap-2">
                    {starters.map((q, i) => (
                      <li key={q} className="as-chip" style={{ "--i": i } as CSSProperties}>
                        <button
                          type="button"
                          onClick={() => void a.ask(q)}
                          disabled={a.pending !== null}
                          className="inline-flex min-h-9 items-center rounded-control border border-border bg-surface px-3.5 py-1.5 text-left text-[13.5px] text-text transition-[background-color,border-color,transform] duration-150 hover:border-border-strong hover:bg-hover active:scale-[0.98] disabled:opacity-50"
                        >
                          {q}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          }
        />
      </div>

      <div ref={end} className="scroll-mb-6">
        {input}
      </div>
    </section>
  )
}
