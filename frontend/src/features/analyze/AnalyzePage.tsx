import { CheckCheck, Lock, RotateCw, ScanSearch } from "lucide-react"
import { useState } from "react"
import { Link } from "react-router"
import { Button } from "../../components/Button"
import { buttonClass } from "../../components/buttonClass"
import { Dialog } from "../../components/Dialog"
import { EmptyState } from "../../components/EmptyState"
import { Spinner } from "../../components/Spinner"
import { healthSummary } from "../../lib/analysis"
import { analysisApi } from "../../lib/api"
import { fmtInt } from "../../lib/format"
import { laneAlpha, laneVar } from "../../lib/lanes"
import type { AnalysisOut } from "../../lib/types"
import { useDataset } from "../import/queries"
import { useWorkspaceContext } from "../workspaces/context"
import { StepHeader } from "../workspaces/StepHeader"
import { ActionError, MockGap } from "./bits"
import { indexColumns, isMockGap } from "./util"
import { DependencyList } from "./DependencyList"
import { DuplicatesSection } from "./DuplicatesCard"
import { InconsistenciesSection } from "./InconsistenciesCard"
import { KeysCard } from "./KeysCard"
import { useAnalysis, useCleanup, useRunAnalysis } from "./queries"

export function AnalyzePage() {
  const { workspace } = useWorkspaceContext()
  const wsId = workspace.id
  const locked = workspace.stage === "empty"
  const analysis = useAnalysis(wsId, !locked)
  const dataset = useDataset(wsId, !locked)
  const run = useRunAnalysis(wsId)
  const acceptAll = useCleanup(wsId, () => analysisApi.acceptAll(wsId))
  const a = analysis.data
  const busy = run.isPending || acceptAll.isPending

  const actions = a ? (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="ghost"
        icon={<RotateCw size={15} />}
        loading={run.isPending}
        disabled={busy}
        onClick={() => run.mutate()}
      >
        Re-run analysis
      </Button>
      <Link to={`/w/${wsId}/design`} className={buttonClass("primary")}>
        Design schema
      </Link>
    </div>
  ) : (
    // only once we know there is no analysis; an error or the mock API says nothing about it
    a === null && (
      <>
        <Button variant="primary" disabled aria-describedby="design-reason">
          Design schema
        </Button>
        <p id="design-reason" className="text-[12.5px] text-muted">
          Run the analysis first.
        </p>
      </>
    )
  )

  let body
  if (locked) {
    body = (
      <EmptyState
        icon={<Lock size={18} strokeWidth={1.5} />}
        title="Import a sheet first."
        action={
          <Link to={`/w/${wsId}/import`} className={buttonClass("primary")}>
            Go to Import
          </Link>
        }
      >
        Analysis works on the imported sheet, so it opens once there is one.
      </EmptyState>
    )
  } else if (analysis.isPending) {
    body = (
      <div className="grid h-60 place-items-center text-muted">
        <Spinner size={20} />
      </div>
    )
  } else if (analysis.error) {
    body = isMockGap(analysis.error) ? (
      <MockGap />
    ) : (
      <EmptyState title="Couldn't load the analysis" lanes={[7, 3]}>
        {analysis.error.message}
      </EmptyState>
    )
  } else if (!a) {
    body = (
      <EmptyState
        icon={run.isPending ? <Spinner size={18} /> : <ScanSearch size={18} strokeWidth={1.5} />}
        title={run.isPending ? "Analyzing the sheet" : "Not analyzed yet"}
        action={
          <div className="flex flex-col items-center gap-2">
            <Button variant="primary" loading={run.isPending} onClick={() => run.mutate()}>
              {run.isPending ? "Analyzing" : "Analyze"}
            </Button>
            <ActionError error={run.error} />
          </div>
        }
      >
        QLens checks which columns determine others, which column sets are unique, and which values look like the same
        thing typed twice
        {workspace.row_count ? (
          <>
            {" "}
            across all <span className="num text-text">{fmtInt(workspace.row_count)}</span> rows
          </>
        ) : null}
        .
      </EmptyState>
    )
  } else {
    const cols = indexColumns(dataset.data?.columns)
    body = (
      <div className="flex flex-col gap-12">
        <HealthStrip
          a={a}
          busy={busy}
          onAcceptAll={() => acceptAll.mutate(undefined)}
          pending={acceptAll.isPending}
          error={acceptAll.error ?? run.error}
        />
        <DuplicatesSection wsId={wsId} groups={a.duplicates} cols={cols} busy={busy} />
        <InconsistenciesSection wsId={wsId} items={a.inconsistencies} fds={a.fds} cols={cols} busy={busy} />
        <DependencyList wsId={wsId} fds={a.fds} cols={cols} />
        <KeysCard keys={a.keys} cols={cols} />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-8 sm:py-12">
      <StepHeader step="analyze" actions={actions} />
      {body}
    </div>
  )
}

function HealthStrip({
  a,
  busy,
  pending,
  error,
  onAcceptAll,
}: {
  a: AnalysisOut
  busy: boolean
  pending: boolean
  error: unknown
  onAcceptAll: () => void
}) {
  const h = healthSummary(a)
  const [confirming, setConfirming] = useState(false)
  const clean = h.issues === 0
  const lane = clean ? 4 : 3
  const pendingDups = a.duplicates.filter((d) => d.status === "pending")
  const sameDups = pendingDups.filter((d) => d.confidence === "same_normalized").length
  const similarDups = pendingDups.length - sameDups
  const approx = h.issues - h.duplicates

  return (
    <div className="rounded-card border border-border bg-surface">
      <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <span
            aria-hidden
            className="grid size-9 shrink-0 place-items-center rounded-full"
            style={{ background: laneAlpha(lane, 0.14) }}
          >
            <span className="size-2.5 rounded-full" style={{ background: laneVar(lane) }} />
          </span>
          <div>
            <p className="text-[20px] font-medium tracking-[-0.025em] text-text">
              {clean ? (
                "No open issues"
              ) : (
                <>
                  <span className="num">{fmtInt(h.issues)}</span> {h.issues === 1 ? "issue" : "issues"} to review
                </>
              )}
            </p>
            <p className="mt-0.5 text-[13.5px] text-muted">
              {clean ? (
                <>
                  Every accepted rule holds on all <span className="num text-text">{fmtInt(a.row_count)}</span> rows.
                </>
              ) : (
                <span className="flex flex-wrap gap-x-4">
                  {h.duplicates > 0 && (
                    <span>
                      <span className="num text-text">{h.duplicates}</span> near-duplicate{" "}
                      {h.duplicates === 1 ? "group" : "groups"}
                    </span>
                  )}
                  {approx > 0 && (
                    <span>
                      <span className="num text-text">{approx}</span> {approx === 1 ? "rule" : "rules"} broken by{" "}
                      <span className="num text-text">{fmtInt(h.inconsistentRows)}</span>{" "}
                      {h.inconsistentRows === 1 ? "row" : "rows"}
                    </span>
                  )}
                </span>
              )}
            </p>
          </div>
        </div>
        {!clean && (
          <Button
            icon={<CheckCheck size={15} />}
            loading={pending}
            disabled={busy || (sameDups === 0 && approx === 0)}
            onClick={() => setConfirming(true)}
          >
            Accept all suggestions
          </Button>
        )}
      </div>
      {error ? (
        <div className="border-t border-border px-5 py-3">
          <ActionError error={error} />
        </div>
      ) : null}

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Accept all suggestions?"
        description="This edits QLens's working copy of the sheet. Your original upload stays untouched."
      >
        <ul className="flex list-disc flex-col gap-2 pl-5 text-[14px] text-text marker:text-faint">
          {sameDups > 0 && (
            <li>
              Merge <span className="num">{sameDups}</span> near-duplicate {sameDups === 1 ? "group" : "groups"} that
              differ only by case or spacing
            </li>
          )}
          {approx > 0 && (
            <li>
              Rewrite <span className="num">{fmtInt(h.inconsistentRows)}</span> disagreeing{" "}
              {h.inconsistentRows === 1 ? "row" : "rows"} to the suggested values
            </li>
          )}
        </ul>
        {similarDups > 0 && (
          <p className="mt-3 text-[13.5px] text-muted">
            <span className="num">{similarDups}</span> {similarDups === 1 ? "group" : "groups"} with merely similar
            spellings stay for you to check.
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setConfirming(false)
              onAcceptAll()
            }}
          >
            Accept all
          </Button>
        </div>
      </Dialog>
    </div>
  )
}
