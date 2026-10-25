import { ArrowLeft, SearchX } from "lucide-react"
import { Link, Outlet, useParams } from "react-router"
import { Badge } from "../../components/Badge"
import { buttonClass } from "../../components/buttonClass"
import { EmptyState } from "../../components/EmptyState"
import { FullPageSpinner } from "../../components/Spinner"
import { StepRail } from "../../components/StepRail"
import { TopBar } from "../../components/TopBar"
import { ApiError } from "../../lib/api"
import { fmtInt } from "../../lib/format"
import { STAGE_META } from "../../lib/steps"
import type { WorkspaceContext } from "./context"
import { useWorkspace } from "./queries"

export function WorkspaceLayout() {
  const id = Number(useParams().id)
  const { data: ws, isPending, error } = useWorkspace(id)

  if (!Number.isInteger(id) || id <= 0 || error) {
    const notFound = !Number.isInteger(id) || (error instanceof ApiError && error.status === 404)
    return (
      <div className="min-h-dvh">
        <TopBar />
        <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
          <EmptyState
            icon={<SearchX size={20} strokeWidth={1.5} />}
            title={notFound ? "Workspace not found" : "Couldn't open this workspace"}
            lanes={[7, 3]}
            action={
              <Link to="/" className={buttonClass()}>
                <ArrowLeft size={15} />
                All workspaces
              </Link>
            }
          >
            {notFound ? "It may have been deleted, or it belongs to another account." : error?.message}
          </EmptyState>
        </main>
      </div>
    )
  }
  if (isPending) return <FullPageSpinner />

  const meta = STAGE_META[ws.stage]

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar>
        <span aria-hidden className="text-[18px] font-light text-faint">
          /
        </span>
        <h1 className="min-w-0 truncate text-[14.5px] font-medium tracking-[-0.01em] text-text">{ws.name}</h1>
        <span className="hidden sm:block">
          <Badge lane={meta.lane}>{meta.label}</Badge>
        </span>
      </TopBar>

      <div className="flex h-[var(--step-strip-h)] items-center border-b border-border md:hidden">
        <StepRail workspaceId={ws.id} stage={ws.stage} orientation="horizontal" />
      </div>

      <div className="flex flex-1">
        <aside className="sticky top-[var(--app-header-h)] hidden h-[calc(100dvh-var(--app-header-h))] w-[232px] shrink-0 flex-col border-r border-border px-3 py-5 md:flex">
          <Link
            to="/"
            className="mb-5 flex h-8 items-center gap-2 rounded-control px-3 text-[13px] text-muted transition-colors hover:text-text"
          >
            <ArrowLeft size={14} strokeWidth={1.75} />
            All workspaces
          </Link>
          <StepRail workspaceId={ws.id} stage={ws.stage} />
          {ws.row_count !== null && (
            <dl className="mt-auto grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-border px-3 pt-4 text-[12.5px]">
              <dt className="text-muted">Rows</dt>
              <dd className="num text-right text-text">{fmtInt(ws.row_count)}</dd>
              <dt className="text-muted">Columns</dt>
              <dd className="num text-right text-text">{fmtInt(ws.column_count ?? 0)}</dd>
              {ws.stage === "applied" && ws.table_count !== null && (
                <>
                  <dt className="text-muted">Tables</dt>
                  <dd className="num text-right text-text">{fmtInt(ws.table_count)}</dd>
                </>
              )}
            </dl>
          )}
        </aside>

        <main className="min-w-0 flex-1">
          <Outlet context={{ workspace: ws } satisfies WorkspaceContext} />
        </main>
      </div>
    </div>
  )
}
