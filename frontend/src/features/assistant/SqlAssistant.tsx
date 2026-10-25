import "./assistant.css"
import { useQueryClient } from "@tanstack/react-query"
import { TextCursorInput } from "lucide-react"
import { useCallback, useMemo, useRef } from "react"
import { historyKey, slowKey } from "../query/queries"
import type { AssistantReply } from "./api"
import { AssistantPage } from "./AssistantPage"
import { AssistantPanel } from "./AssistantPanel"
import { BarError } from "./BarError"
import { CommandBar } from "./CommandBar"
import { querySuggestions } from "./logic"
import type { SqlAction } from "./Thread"
import { useAssistant } from "./useAssistant"

export interface SqlAssistantProps {
  wsId: number
  /** the screen it sits on; both read and run SELECTs, neither edits the design */
  context: "query" | "data"
  /** the applied tables (lane, and which tables their foreign keys point at) */
  tables: { name: string; color_index: number | null; columns: { fk?: { table: string } | null }[] }[]
  /** where SQL the assistant wrote can go (e.g. the editor); without it, SQL blocks offer only Copy */
  onInsertSql?: (sql: string) => void
  /** the label of that action */
  insertLabel?: string
  /** sidebar: a bar in the page, answers slide in from the right; page: the whole thread inline, full width */
  variant?: "sidebar" | "page"
  /** questions to start from (page variant), e.g. read off the schema */
  starters?: string[]
}

const INTRO: Record<SqlAssistantProps["context"], string> = {
  query:
    "Ask about the rows in your tables. I can write a SELECT, run it read-only and show what came back; Insert into editor puts the SQL in the editor as a new query.",
  data: "Ask about the rows in your tables in plain English. The assistant writes one SELECT, runs it as this workspace's read-only database role, and answers with the rows and the SQL it used. It never changes your data. Open in SQL tab puts the SQL in the editor.",
}

/**
 * The read-only assistant (Query screen, Data screen): the bar sits in the page under its header;
 * answers open the sidebar, where SQL the assistant wrote can be copied or handed to the page.
 */
export function SqlAssistant({
  wsId,
  context,
  tables,
  onInsertSql,
  insertLabel = "Insert into editor",
  variant = "sidebar",
  starters,
}: SqlAssistantProps) {
  const qc = useQueryClient()
  const dockInput = useRef<HTMLInputElement>(null)
  const inlineInput = useRef<HTMLInputElement>(null)

  const onReply = useCallback(
    (r: AssistantReply) => {
      // the assistant's runs are recorded in History (source "From English")
      if (r.sql_runs.length || r.actions.some((x) => x.tool === "run_sql")) {
        void qc.invalidateQueries({ queryKey: historyKey(wsId) })
        void qc.invalidateQueries({ queryKey: slowKey(wsId) })
      }
      return null
    },
    [qc, wsId],
  )
  const a = useAssistant({ wsId, context, onReply })

  const examples = useMemo(
    () =>
      querySuggestions(
        tables.map((t) => ({ name: t.name, refs: t.columns.flatMap((c) => (c.fk ? [c.fk.table] : [])) })),
      ),
    [tables],
  )
  const laneOf = useCallback((name: string) => tables.find((t) => t.name === name)?.color_index ?? null, [tables])
  const sqlAction: SqlAction | null = onInsertSql
    ? {
        label: insertLabel,
        icon: <TextCursorInput size={13} strokeWidth={1.9} />,
        run: (sql) => {
          onInsertSql(sql)
          // narrow screens: the sidebar covers the page, so get out of the way
          if (variant === "sidebar" && window.matchMedia("(max-width: 1023px)").matches) a.setOpen(false)
        },
      }
    : null

  const send = (text: string) => {
    a.setDraft("")
    void a.ask(text)
  }

  if (variant === "page")
    return (
      <AssistantPage
        a={a}
        wsId={wsId}
        laneOf={laneOf}
        sqlAction={sqlAction}
        intro={INTRO[context]}
        starters={starters ?? examples}
        input={
          <CommandBar
            variant="inline"
            value={a.draft}
            onChange={a.setDraft}
            onSubmit={send}
            pending={a.pending}
            examples={starters?.length ? starters : examples}
            hotkey
            inputRef={inlineInput}
            label={a.turns.length ? "Ask a follow-up" : "Ask a question about your data"}
          />
        }
      />
    )

  return (
    <>
      <div className="flex max-w-[760px] flex-col gap-2.5">
        <CommandBar
          variant="inline"
          value={a.draft}
          onChange={a.setDraft}
          onSubmit={send}
          pending={a.pending}
          examples={examples}
          suggestions={a.error || a.open ? [] : examples}
          hotkey={!a.open}
          inputRef={inlineInput}
          label="Ask about your data; the assistant can write and run a SELECT"
        />
        {a.error && !a.open && (
          <div className="self-start">
            <BarError error={a.error.error} onRetry={a.retry} onClose={a.clearError} />
          </div>
        )}
      </div>
      <AssistantPanel
        a={a}
        wsId={wsId}
        laneOf={laneOf}
        sqlAction={sqlAction}
        footer={
          <CommandBar
            variant="docked"
            value={a.draft}
            onChange={a.setDraft}
            onSubmit={send}
            pending={a.pending}
            examples={examples}
            hotkey={a.open}
            inputRef={dockInput}
            label="Ask a follow-up"
          />
        }
        intro={INTRO[context]}
      />
    </>
  )
}

export default SqlAssistant
