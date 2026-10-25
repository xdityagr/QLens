import { Lock, RotateCw, ScanSearch } from "lucide-react"
import { useMemo, useState, type ReactNode } from "react"
import { Link } from "react-router"
import { Button } from "../../components/Button"
import { buttonClass } from "../../components/buttonClass"
import { EmptyState } from "../../components/EmptyState"
import { NoiseBackdrop } from "../../components/NoiseBackdrop"
import { Spinner } from "../../components/Spinner"
import { buildAnatomy, type AnatomyEdge } from "../../lib/anatomy"
import { analysisApi } from "../../lib/api"
import { fmtInt } from "../../lib/format"
import type { AnalysisOut, ColumnOut } from "../../lib/types"
import { useDataset } from "../import/queries"
import { useWorkspaceContext } from "../workspaces/context"
import { StepHeader } from "../workspaces/StepHeader"
import { AnatomySection } from "./Anatomy"
import { ActionError, MockGap } from "./bits"
import { DependencyList } from "./DependencyList"
import { HealthBar } from "./HealthBar"
import { usePrefersReducedMotion } from "./hooks"
import { IssuesPanel } from "./Issues"
import { useAnalysis, useCleanup, useRunAnalysis } from "./queries"
import { indexColumns, isMockGap, ruleId, type ColumnIndex } from "./util"

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
    body = (
      <Analysis
        wsId={wsId}
        a={a}
        columns={dataset.data?.columns}
        busy={busy}
        acceptAll={
          <HealthBar
            a={a}
            busy={busy}
            onAcceptAll={() => acceptAll.mutate(undefined)}
            pending={acceptAll.isPending}
            error={acceptAll.error ?? run.error}
          />
        }
      />
    )
  }

  return (
    <div className="relative">
      {/* drifting grain glow behind the title only; it fades out before any data starts */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[230px] overflow-hidden [mask-image:linear-gradient(to_bottom,black_35%,transparent)]"
      >
        <NoiseBackdrop lanes={[0, 1]} intensity={0.13} animated />
      </div>
      <div className="relative mx-auto max-w-[1200px] px-4 py-10 sm:px-8 sm:py-12">
        <StepHeader step="analyze" actions={actions} />
        {body}
      </div>
    </div>
  )
}

/** The analysis itself: health, sheet structure, then issues beside the rules. */
function Analysis({
  wsId,
  a,
  columns,
  busy,
  acceptAll,
}: {
  wsId: number
  a: AnalysisOut
  columns: ColumnOut[] | undefined
  busy: boolean
  acceptAll: ReactNode
}) {
  const [showDerived, setShowDerived] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [focus, setFocus] = useState<{ fdId: number; n: number } | null>(null)
  const reduced = usePrefersReducedMotion()
  const cols: ColumnIndex = useMemo(() => indexColumns(columns), [columns])
  const anatomy = useMemo(() => buildAnatomy(a, columns ?? [], { showDerived }), [a, columns, showDerived])
  const derivedCount = a.fds.filter((f) => f.is_derived).length

  // An approximate rule's edge leads to its inconsistency; any other edge to its line in the rules list.
  const activateEdge = (e: AnatomyEdge) => {
    if (e.kind === "approx" && e.accepted) {
      setFocus((f) => ({ fdId: e.fdId, n: (f?.n ?? 0) + 1 }))
      return
    }
    const el = document.getElementById(ruleId(e.fdId))
    if (!el) return
    el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" })
    el.focus({ preventScroll: true })
    el.classList.remove("anim-flash")
    void el.offsetWidth // restart the highlight if it is clicked twice
    el.classList.add("anim-flash")
  }

  return (
    <div className="flex flex-col gap-8">
      {acceptAll}
      <AnatomySection
        anatomy={anatomy}
        cols={cols}
        derivedCount={derivedCount}
        showDerived={showDerived}
        onShowDerived={setShowDerived}
        selected={selected}
        onSelect={setSelected}
        onEdgeActivate={activateEdge}
      />
      <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.62fr)]">
        <IssuesPanel wsId={wsId} a={a} cols={cols} busy={busy} focus={focus} />
        <DependencyList wsId={wsId} fds={a.fds} cols={cols} showDerived={showDerived} selected={selected} />
      </div>
    </div>
  )
}
