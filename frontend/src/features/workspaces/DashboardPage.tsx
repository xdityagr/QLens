import { Plus, RotateCw } from "lucide-react"
import { useMemo, useState } from "react"
import { Button } from "../../components/Button"
import { EmptyState } from "../../components/EmptyState"
import { NoiseBackdrop } from "../../components/NoiseBackdrop"
import { TopBar } from "../../components/TopBar"
import type { WorkspaceOut } from "../../lib/types"
import { useMe } from "../auth/useAuth"
import "../landing/landing.css"
import { Untangle } from "../landing/Untangle"
import { dashboardStats, greeting, mostRecent } from "./dashboard"
import { ActivityList, ContinueCard, SamplesPanel, StatsRow } from "./DashboardParts"
import { HeroGraph } from "./HeroGraph"
import { useWorkspaces } from "./queries"
import { useTrySample } from "./useTrySample"
import { WorkspaceCard } from "./WorkspaceCard"
import { DeleteWorkspaceDialog, NewWorkspaceDialog } from "./WorkspaceDialogs"

function firstName(name?: string) {
  return name?.trim().split(/\s+/)[0] ?? ""
}

export function DashboardPage() {
  const { data: me } = useMe()
  const { data: workspaces, isPending, error, refetch, isRefetching } = useWorkspaces()
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<WorkspaceOut | null>(null)
  const trySample = useTrySample()

  const stats = useMemo(() => dashboardStats(workspaces ?? []), [workspaces])
  const recent = useMemo(() => mostRecent(workspaces ?? []), [workspaces])
  const sorted = useMemo(
    () => [...(workspaces ?? [])].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" })),
    [workspaces],
  )
  const empty = workspaces !== undefined && workspaces.length === 0
  const name = firstName(me?.display_name)

  const samples = (
    <SamplesPanel
      onTry={(s) => trySample.mutate(s)}
      pending={trySample.isPending ? (trySample.variables?.name ?? null) : null}
      error={trySample.error?.message}
      compact={empty}
    />
  )

  return (
    <div className="min-h-dvh">
      <TopBar />

      <section className="relative isolate overflow-hidden border-b border-border">
        <NoiseBackdrop lanes={[0, 1]} intensity={0.18} placement="top" />
        <div className="relative mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-6 px-4 pb-8 pt-10 sm:px-6 sm:pt-12">
          <HeroGraph className="ld-drift absolute -top-24 right-[-40px] hidden scale-[0.8] opacity-50 lg:block" />
          <div className="relative min-w-0">
            <h1 className="text-[30px] font-medium leading-[1.05] tracking-[-0.04em] text-text sm:text-[36px]">
              {greeting()}
              {name ? `, ${name}` : ""}.
            </h1>
            <p className="mt-2 max-w-[52ch] text-[15px] text-muted">
              {empty
                ? "Bring a spreadsheet and QLens turns it into related PostgreSQL tables."
                : "Pick up a workspace, or start a new one from a sheet."}
            </p>
          </div>
          {!empty && (
            <div className="relative flex flex-wrap gap-2">
              <Button variant="primary" icon={<Plus size={16} strokeWidth={2} />} onClick={() => setCreating(true)}>
                New workspace
              </Button>
            </div>
          )}
        </div>
      </section>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {isPending ? (
          <div aria-busy className="flex flex-col gap-6">
            <div className="h-[94px] animate-pulse rounded-card border border-border bg-surface" />
            <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="h-[230px] animate-pulse rounded-card border border-border bg-surface" />
              <div className="h-[230px] animate-pulse rounded-card border border-border bg-surface" />
            </div>
          </div>
        ) : error ? (
          <EmptyState
            title="Couldn't load your workspaces"
            lanes={[7, 3]}
            action={
              <Button icon={<RotateCw size={15} />} loading={isRefetching} onClick={() => refetch()}>
                Try again
              </Button>
            }
          >
            {error.message}
          </EmptyState>
        ) : empty ? (
          <section className="relative isolate overflow-hidden rounded-card border border-border bg-surface">
            <NoiseBackdrop lanes={[0, 1]} intensity={0.12} placement="center" />
            <div className="relative grid gap-10 p-6 sm:p-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:items-center">
              <div className="min-w-0">
                <Untangle />
              </div>
              <div>
                <h2 className="text-[26px] font-medium leading-tight tracking-[-0.035em] text-text">Start with a sheet</h2>
                <p className="mt-2 max-w-[44ch] text-[14.5px] leading-relaxed text-muted">
                  Create a workspace and upload a CSV or Excel file, or open one of the bundled samples to see the whole
                  flow on real-looking data.
                </p>
                <Button className="mt-5" variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>
                  New workspace
                </Button>
                <div className="mt-8 border-t border-border pt-6">{samples}</div>
              </div>
            </div>
          </section>
        ) : (
          <div className="flex flex-col gap-8">
            <StatsRow stats={stats} />
            <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="flex min-w-0 flex-col gap-8">
                {recent && <ContinueCard ws={recent} />}
                <section aria-labelledby="all-ws-h">
                  <div className="mb-4 flex items-baseline gap-2.5">
                    <h2 id="all-ws-h" className="text-[18px] font-medium tracking-[-0.02em]">
                      All workspaces
                    </h2>
                    <span className="num text-[13px] text-faint">{sorted.length}</span>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    {sorted.map((ws) => (
                      <WorkspaceCard key={ws.id} ws={ws} onDelete={setDeleting} />
                    ))}
                  </div>
                </section>
              </div>
              <aside className="flex flex-col gap-6">
                {samples}
                <ActivityList workspaces={workspaces} />
              </aside>
            </div>
          </div>
        )}
      </main>

      <NewWorkspaceDialog open={creating} onClose={() => setCreating(false)} />
      <DeleteWorkspaceDialog workspace={deleting} onClose={() => setDeleting(null)} />
    </div>
  )
}
