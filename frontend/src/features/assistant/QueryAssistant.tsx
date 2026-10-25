import "./assistant.css"
import { useQueryClient } from "@tanstack/react-query"
import { TextCursorInput } from "lucide-react"
import { useCallback, useMemo, useRef } from "react"
import { historyKey, slowKey } from "../query/queries"
import type { AssistantReply } from "./api"
import { AssistantPanel } from "./AssistantPanel"
import { BarError } from "./BarError"
import { CommandBar } from "./CommandBar"
import { querySuggestions } from "./logic"
import type { SqlAction } from "./Thread"
import { useAssistant } from "./useAssistant"

/**
 * The assistant on the Query screen: the bar sits under the header; answers open the sidebar, where SQL
 * the assistant wrote can go into the editor. It can read and run SELECTs here, but not edit the design.
 */
export function QueryAssistant({
  wsId,
  tables,
  onInsertSql,
}: {
  wsId: number
  /** the applied tables (lane, and which tables their foreign keys point at) */
  tables: { name: string; color_index: number | null; columns: { fk?: { table: string } | null }[] }[]
  /** put SQL into the editor as a new, unsaved query */
  onInsertSql: (sql: string) => void
}) {
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
  const a = useAssistant({ wsId, context: "query", onReply })

  const examples = useMemo(
    () =>
      querySuggestions(
        tables.map((t) => ({ name: t.name, refs: t.columns.flatMap((c) => (c.fk ? [c.fk.table] : [])) })),
      ),
    [tables],
  )
  const laneOf = useCallback((name: string) => tables.find((t) => t.name === name)?.color_index ?? null, [tables])
  const sqlAction: SqlAction = {
    label: "Insert into editor",
    icon: <TextCursorInput size={13} strokeWidth={1.9} />,
    run: (sql) => {
      onInsertSql(sql)
      // narrow screens: the sidebar covers the editor, so get out of the way
      if (window.matchMedia("(max-width: 1023px)").matches) a.setOpen(false)
    },
  }

  const send = (text: string) => {
    a.setDraft("")
    void a.ask(text)
  }

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
            onEscape={() => a.setOpen(false)}
          />
        }
        intro="Ask about the rows in your tables. I can write a SELECT, run it read-only and show what came back; Insert into editor puts the SQL in the editor as a new query."
      />
    </>
  )
}
