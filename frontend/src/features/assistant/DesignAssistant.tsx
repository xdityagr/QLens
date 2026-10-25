import "./assistant.css"
import { useQueryClient } from "@tanstack/react-query"
import { SquareArrowOutUpRight } from "lucide-react"
import { useCallback, useMemo, useRef } from "react"
import { useNavigate } from "react-router"
import { diffProposals } from "../../lib/proposalDiff"
import type { ProposalOut } from "../../lib/types"
import { proposalKey, proposalSqlKey } from "../design/queries"
import { analysisKey } from "../import/queries"
import type { AssistantReply } from "./api"
import { AssistantPanel } from "./AssistantPanel"
import { BarError } from "./BarError"
import { CommandBar } from "./CommandBar"
import { EditToast } from "./EditToast"
import { designSuggestions } from "./logic"
import type { SqlAction } from "./Thread"
import { useAssistant } from "./useAssistant"

/**
 * The assistant on the Design canvas: the floating bar (in AssistantSlot), the edit toast above it,
 * and the sidebar for answers. An edit reply carries the new draft; it goes straight into the proposal
 * cache, and the diagram animates from the old version to it.
 */
export function DesignAssistant({
  wsId,
  proposal,
  queryable,
}: {
  wsId: number
  proposal: ProposalOut
  queryable: boolean
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const floatInput = useRef<HTMLInputElement>(null)
  const dockInput = useRef<HTMLInputElement>(null)

  // A new design version goes straight into the proposal cache; the diagram animates from the old one.
  const showDesign = useCallback(
    (next: ProposalOut, flipsChanged: boolean) => {
      const prev = qc.getQueryData<ProposalOut | null>(proposalKey(wsId))
      const changes = prev ? diffProposals(prev.tables, next.tables).changes : null
      qc.setQueryData(proposalKey(wsId), next)
      void qc.invalidateQueries({ queryKey: proposalSqlKey(wsId) })
      // switching a dependency off or on changes what Analyze shows as accepted
      if (flipsChanged) void qc.invalidateQueries({ queryKey: analysisKey(wsId) })
      return changes
    },
    [qc, wsId],
  )
  const onReply = useCallback(
    (r: AssistantReply) =>
      r.proposal
        ? showDesign(
            r.proposal,
            r.actions.some((x) => x.ok && (x.tool === "set_dependency_accepted" || x.tool === "undo_last_edit")),
          )
        : null,
    [showDesign],
  )
  // an undo may put dependency flags back, so Analyze is refreshed too
  const onUndo = useCallback((p: ProposalOut) => showDesign(p, true), [showDesign])
  const a = useAssistant({ wsId, context: "design", onReply, onUndo })

  const examples = useMemo(() => designSuggestions(proposal.tables), [proposal.tables])
  const laneOf = useCallback(
    (name: string) => proposal.tables.find((t) => t.name === name)?.color_index ?? null,
    [proposal.tables],
  )
  const sqlAction: SqlAction | null = queryable
    ? {
        label: "Open in SQL",
        icon: <SquareArrowOutUpRight size={13} strokeWidth={1.9} />,
        run: (sql) => navigate(`/w/${wsId}/data?tab=sql`, { state: { open: { sql } } }),
      }
    : null

  const send = (text: string) => {
    a.setDraft("")
    void a.ask(text)
  }
  const bar = (variant: "float" | "docked") => (
    <CommandBar
      variant={variant}
      value={a.draft}
      onChange={a.setDraft}
      onSubmit={send}
      pending={a.pending}
      examples={examples}
      // the chips sit where the toast and errors show; one thing at a time
      suggestions={a.error || a.toast ? [] : examples}
      hotkey={variant === "float" ? !a.open : a.open}
      inputRef={variant === "float" ? floatInput : dockInput}
      label="Ask about the design or say what to change"
    />
  )

  return (
    <>
      {/* on a phone the zoom controls share the bottom edge; keep clear of them */}
      <div className="flex w-full max-w-[620px] flex-col items-center gap-2.5 pl-11 sm:pl-0">
        {a.toast && (
          <EditToast
            toast={a.toast}
            undoing={a.undoing}
            onUndo={() => void a.undo()}
            onDetails={() => a.setOpen(true)}
            onClose={a.dismissToast}
          />
        )}
        {a.error && !a.open && <BarError error={a.error.error} onRetry={a.retry} onClose={a.clearError} />}
        {/* while the sidebar is open its own input takes over */}
        <div
          className={
            "w-full transition-[opacity,transform] duration-200 " +
            (a.open ? "pointer-events-none translate-y-3 opacity-0" : "")
          }
          inert={a.open}
        >
          {bar("float")}
        </div>
      </div>
      <AssistantPanel
        a={a}
        wsId={wsId}
        laneOf={laneOf}
        sqlAction={sqlAction}
        footer={bar("docked")}
        intro="Ask why a column sits in a table or whether one column decides another, or tell me what to change: rename a table, stop using a dependency, undo. Questions, your table structure and up to 50 result rows are sent to Google Gemini."
      />
    </>
  )
}

export default DesignAssistant
