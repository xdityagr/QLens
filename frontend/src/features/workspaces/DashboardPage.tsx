import { FileSpreadsheet, Plus, RotateCw } from "lucide-react"
import { useState } from "react"
import { Button } from "../../components/Button"
import { EmptyState } from "../../components/EmptyState"
import { NoiseBackdrop } from "../../components/NoiseBackdrop"
import { TopBar } from "../../components/TopBar"
import type { WorkspaceOut } from "../../lib/types"
import { useMe } from "../auth/useAuth"
import { HeroGraph } from "./HeroGraph"
import { useWorkspaces } from "./queries"
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

  return (
    <div className="min-h-dvh">
      <TopBar />

      <section className="relative isolate overflow-hidden border-b border-border">
        <NoiseBackdrop lanes={[0, 1]} intensity={0.2} placement="top" />
        <div className="relative mx-auto max-w-6xl px-4 pb-14 pt-16 sm:px-6 sm:pb-16 sm:pt-20">
          <HeroGraph className="absolute -top-6 right-0 hidden lg:block" />
          {me && <p className="mb-4 text-[14px] text-muted">Hi {firstName(me.display_name) || "there"}.</p>}
          <h1 className="max-w-[16ch] text-[40px] font-medium leading-[1.02] tracking-[-0.045em] text-text sm:text-[56px]">
            Turn messy sheets into real databases.
          </h1>
          <p className="mt-5 max-w-[52ch] text-[15.5px] leading-relaxed text-muted">
            Import a spreadsheet, see which columns depend on which, and get a normalized PostgreSQL schema you can
            query, explain and tune.
          </p>
          <div className="mt-8">
            <Button variant="primary" icon={<Plus size={16} strokeWidth={2} />} onClick={() => setCreating(true)}>
              New workspace
            </Button>
          </div>
        </div>
      </section>

      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <div className="mb-5 flex items-baseline gap-2.5">
          <h2 className="text-[18px] font-medium tracking-[-0.02em]">Workspaces</h2>
          {workspaces && workspaces.length > 0 && <span className="num text-[13px] text-faint">{workspaces.length}</span>}
        </div>

        {isPending ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-busy>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[178px] animate-pulse rounded-card border border-border bg-surface" />
            ))}
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
        ) : workspaces.length === 0 ? (
          <EmptyState
            icon={<FileSpreadsheet size={20} strokeWidth={1.5} />}
            title="No workspaces yet"
            action={
              <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>
                New workspace
              </Button>
            }
          >
            Create one, import a CSV or Excel sheet, and QLens takes it from there.
          </EmptyState>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {workspaces.map((ws) => (
              <WorkspaceCard key={ws.id} ws={ws} onDelete={setDeleting} />
            ))}
          </div>
        )}
      </main>

      <NewWorkspaceDialog open={creating} onClose={() => setCreating(false)} />
      <DeleteWorkspaceDialog workspace={deleting} onClose={() => setDeleting(null)} />
    </div>
  )
}
