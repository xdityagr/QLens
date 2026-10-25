import { FilePlus2, Lock, PanelRightClose, PanelRightOpen, RotateCw } from "lucide-react"
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { Link } from "react-router"
import { Badge } from "../../components/Badge"
import { Button } from "../../components/Button"
import { buttonClass } from "../../components/buttonClass"
import { EmptyState } from "../../components/EmptyState"
import { Spinner } from "../../components/Spinner"
import { Tabs } from "../../components/Tabs"
import { ApiError } from "../../lib/api"
import { STEPS } from "../../lib/steps"
import type { ProposalOut } from "../../lib/types"
import { useWorkspaceContext } from "../workspaces/context"
import { StepHeader } from "../workspaces/StepHeader"
import { AppliedResult, ApplyFailure, ApplyProgress, type AppliedSummary } from "./ApplyPanel"
import { AssistantSlot } from "./AssistantSlot"
import { ErContext, type ErContextValue, type RenameTarget } from "./erContext"
import { useApply, useAppliedSchema, useAssistantEnabled, useBuildProposal, useProposal, useRename } from "./queries"
import { SqlPanel } from "./SqlPanel"
import { WhyPanel } from "./WhyPanel"

// React Flow and dagre load with the canvas, not with the rest of the app.
const loadDiagram = () => import("./ErDiagram")
const ErDiagram = lazy(loadDiagram)

type Tab = "why" | "sql"
const STEP_INDEX = STEPS.findIndex((s) => s.key === "design")
const PANEL_KEY = "qlens.design.panel"

// Open by default only where the canvas still has room beside it; the viewer's own choice wins.
function initialPanelOpen(): boolean {
  try {
    const saved = localStorage.getItem(PANEL_KEY)
    if (saved === "open" || saved === "closed") return saved === "open"
  } catch {
    // storage blocked; fall through to the width rule
  }
  return typeof window === "undefined" || window.matchMedia("(min-width: 1600px)").matches
}

export function DesignPage() {
  const { workspace } = useWorkspaceContext()
  const wsId = workspace.id
  const locked = workspace.stage === "empty" || workspace.stage === "imported"
  const proposal = useProposal(wsId, !locked)
  // fetch the canvas code while the design is being fetched or built, not after
  useEffect(() => {
    if (!locked) void loadDiagram()
  }, [locked])

  if (locked)
    return (
      <div className="mx-auto max-w-[1200px] px-4 py-10 sm:px-8 sm:py-12">
        <StepHeader step="design" />
        <EmptyState
          icon={<Lock size={18} strokeWidth={1.5} />}
          title={workspace.stage === "empty" ? "Import a sheet first." : "Run the analysis first."}
          action={
            <Link
              to={`/w/${wsId}/${workspace.stage === "empty" ? "import" : "analyze"}`}
              className={buttonClass("primary")}
            >
              Go to {workspace.stage === "empty" ? "Import" : "Analyze"}
            </Link>
          }
        >
          The design is built from the dependencies the analysis finds, so it opens once there is one.
        </EmptyState>
      </div>
    )

  if (proposal.isPending)
    return (
      <Centered>
        <Spinner size={20} />
        <p className="text-[14px] text-muted">Building the design from your accepted dependencies</p>
      </Centered>
    )

  if (proposal.error || !proposal.data)
    return (
      <div className="mx-auto max-w-[1200px] px-4 py-10 sm:px-8 sm:py-12">
        <StepHeader step="design" />
        <EmptyState title="Couldn't load the design" lanes={[7, 3]}>
          {proposal.error?.message ?? "This workspace has no sheet yet."}
        </EmptyState>
      </div>
    )

  return <Design wsId={wsId} sheetRows={workspace.row_count} p={proposal.data} />
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-[calc(100dvh-3.5rem)] min-h-[420px] place-items-center">
      <div className="flex flex-col items-center gap-3">{children}</div>
    </div>
  )
}

function Design({ wsId, sheetRows, p }: { wsId: number; sheetRows: number | null; p: ProposalOut }) {
  const build = useBuildProposal(wsId)
  const rename = useRename(wsId)
  const apply = useApply(wsId)
  const applied = p.status === "applied"
  const schema = useAppliedSchema(wsId, applied)
  const assistant = useAssistantEnabled()
  const [tab, setTab] = useState<Tab>("why")
  const [panelOpen, setPanelOpenState] = useState(initialPanelOpen)
  const setPanelOpen = (open: boolean) => {
    setPanelOpenState(open)
    try {
      localStorage.setItem(PANEL_KEY, open ? "open" : "closed")
    } catch {
      // not remembered; fine
    }
  }
  const [hovered, setHovered] = useState<number | null>(null)

  // What the result card shows: this session's apply, else what the catalog says exists now.
  const summary: AppliedSummary | null = useMemo(() => {
    if (!applied) return null
    if (apply.data)
      return { rows: apply.data.staging_rows, tables: apply.data.tables, durationMs: apply.data.duration_ms }
    if (schema.data && sheetRows !== null) return { rows: sheetRows, tables: schema.data.tables, durationMs: null }
    return null
  }, [applied, apply.data, schema.data, sheetRows])

  const { mutateAsync: renameAsync } = rename
  const doRename = useCallback(
    async (target: RenameTarget, name: string) => {
      await renameAsync({ target, name })
    },
    [renameAsync],
  )

  const ctx: ErContextValue = useMemo(() => {
    const related = new Set<number>()
    if (hovered !== null)
      for (const t of p.tables)
        for (const c of t.columns) {
          if (c.role !== "fk" || c.references_table_id === null) continue
          if (t.id === hovered) related.add(c.references_table_id)
          if (c.references_table_id === hovered) related.add(t.id)
        }
    return {
      editable: p.status === "draft",
      rename: doRename,
      hovered,
      setHovered,
      related: hovered === null ? null : related,
      rowCounts: summary ? new Map(summary.tables.map((t) => [t.name, t.row_count])) : null,
      laneOf: new Map(p.tables.map((t) => [t.id, t.color_index])),
    }
  }, [p, doRename, hovered, summary])

  const busy = build.isPending || apply.isPending || rename.isPending
  const failure = !applied && apply.error ? apply.error : null
  const buildError = build.error

  const actions = applied ? (
    <>
      <Button
        icon={<FilePlus2 size={15} />}
        loading={build.isPending}
        disabled={busy}
        onClick={() => build.mutate(undefined, { onSuccess: () => apply.reset() })}
        title="Start a new draft from the accepted dependencies. The applied tables stay until you apply again."
      >
        Edit as new draft
      </Button>
      <Link to={`/w/${wsId}/query`} className={buttonClass("primary")}>
        Open Query
      </Link>
    </>
  ) : (
    <>
      <Button
        variant="ghost"
        icon={<RotateCw size={15} />}
        loading={build.isPending}
        disabled={busy}
        onClick={() => build.mutate(undefined, { onSuccess: () => apply.reset() })}
        title="Build the draft again from the dependencies accepted in Analyze. Renames are discarded."
      >
        Rebuild
      </Button>
      <Button
        variant="primary"
        loading={apply.isPending}
        disabled={busy}
        onClick={() => {
          setPanelOpenState(true) // the progress and the result live in the panel
          apply.mutate(p.id)
        }}
      >
        {apply.isPending ? "Applying" : "Apply design"}
      </Button>
    </>
  )

  return (
    <ErContext.Provider value={ctx}>
      <div className="flex flex-col lg:h-[calc(100dvh-3.5rem)] lg:min-h-[560px] lg:flex-row">
        <section aria-label="Proposed tables" className="relative h-[68vh] min-h-[440px] min-w-0 lg:h-auto lg:flex-1">
          <Suspense
            fallback={
              <div className="grid h-full place-items-center text-muted">
                <Spinner size={18} />
              </div>
            }
          >
            <ErDiagram tables={p.tables} />
          </Suspense>

          {/* title and actions float over the canvas; the band fades the grid so they stay readable */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-[var(--bg)] via-[color-mix(in_oklab,var(--bg)_75%,transparent)] to-transparent"
          />
          <header className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start justify-between gap-3 px-5 pt-5 sm:px-6">
            <div className="pointer-events-auto min-w-0">
              <p className="text-[12.5px] text-muted">
                Step {STEP_INDEX + 1} of {STEPS.length}
              </p>
              <div className="mt-0.5 flex items-center gap-2.5">
                <h2 className="text-[26px] font-medium leading-tight tracking-[-0.035em] text-text">Design</h2>
                <Badge lane={applied ? 4 : 1}>{applied ? "Applied" : "Draft"}</Badge>
              </div>
              <p className="mt-1 max-w-[52ch] text-[13px] leading-relaxed text-muted">
                {applied
                  ? "These tables exist in your database now. Start a new draft to change them."
                  : "Double-click a table or column name to rename it. Drag tables to arrange them."}
              </p>
            </div>
            <div className="pointer-events-auto flex flex-wrap items-center gap-2">
              {actions}
              {/* the panel sits under the canvas on small screens, so the toggle is desktop-only */}
              <span className="hidden lg:contents">
                <Button
                  variant="ghost"
                  onClick={() => setPanelOpen(!panelOpen)}
                  aria-expanded={panelOpen}
                  aria-controls="design-panel"
                  icon={
                    panelOpen ? (
                      <PanelRightClose size={16} strokeWidth={1.6} />
                    ) : (
                      <PanelRightOpen size={16} strokeWidth={1.6} />
                    )
                  }
                >
                  {panelOpen ? "Hide details" : "Details"}
                </Button>
              </span>
            </div>
          </header>

          {assistant && <AssistantSlot />}
        </section>

        <aside
          id="design-panel"
          aria-label="Design details"
          className={
            "er-panel-in flex min-h-0 w-full flex-col border-t border-border bg-bg lg:w-[380px] lg:shrink-0 lg:border-l lg:border-t-0 " +
            (panelOpen ? "" : "lg:hidden")
          }
        >
          {(apply.isPending || failure || summary || buildError) && (
            <div className="flex flex-col gap-3 px-5 pt-5">
              {apply.isPending && <ApplyProgress tableCount={p.tables.length} rows={sheetRows} />}
              {failure && <ApplyFailure error={failure} />}
              {summary && <AppliedResult summary={summary} />}
              {buildError && (
                <p role="alert" className="text-[13px] text-danger">
                  {buildError instanceof ApiError ? buildError.message : "Couldn't build a new draft."}
                </p>
              )}
            </div>
          )}
          <Tabs<Tab>
            className="mx-5 mt-4"
            value={tab}
            onChange={setTab}
            items={[
              { key: "why", label: "Why this design" },
              { key: "sql", label: "SQL" },
            ]}
          />
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-5" role="tabpanel">
            {tab === "why" ? (
              <WhyPanel proposal={p} hovered={hovered} onHover={setHovered} />
            ) : (
              <SqlPanel wsId={wsId} />
            )}
          </div>
        </aside>
      </div>
    </ErContext.Provider>
  )
}
