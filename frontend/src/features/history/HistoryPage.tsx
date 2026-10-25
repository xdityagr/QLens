import { Lock, TerminalSquare, Turtle } from "lucide-react"
import { useMemo } from "react"
import { Link, useNavigate } from "react-router"
import { buttonClass } from "../../components/buttonClass"
import { EmptyState } from "../../components/EmptyState"
import { Spinner } from "../../components/Spinner"
import { fmtInt, fmtMs, fmtRelative } from "../../lib/format"
import { laneAlpha, laneVar } from "../../lib/lanes"
import type { RunOut, RunSource, RunStatus, SlowQuery } from "../query/api"
import { useHistory, useSavedQueries, useSlowQueries } from "../query/queries"
import type { OpenInEditor } from "../data/SqlTab"
import "../query/query.css"
import { useWorkspaceContext } from "../workspaces/context"
import { StepHeader } from "../workspaces/StepHeader"

const SOURCE: Record<RunSource, { label: string; lane: number }> = {
  typed: { label: "Typed", lane: 0 },
  english: { label: "From English", lane: 1 },
  stepthrough: { label: "Step-through", lane: 5 },
  perf: { label: "Performance", lane: 2 },
}

const STATUS: Record<RunStatus, { label: string; lane: number }> = {
  ok: { label: "OK", lane: 4 },
  error: { label: "Error", lane: 7 },
  timeout: { label: "Timed out", lane: 3 },
}

/** One line of SQL for a table cell: comments dropped, whitespace collapsed. */
function snippet(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

const absTime = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })

export function HistoryPage() {
  const { workspace } = useWorkspaceContext()
  if (workspace.stage !== "applied") {
    return (
      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-8 sm:py-12">
        <StepHeader step="history" />
        <EmptyState
          icon={<Lock size={18} strokeWidth={1.5} />}
          title="Apply a design first"
          lanes={[0, 4]}
          action={
            <Link to={`/w/${workspace.id}/design`} className={buttonClass("primary")}>
              Go to Design
            </Link>
          }
        >
          History lists the queries you run against your tables, so it fills up once Design has created them.
        </EmptyState>
      </div>
    )
  }
  return <HistoryBody wsId={workspace.id} />
}

function HistoryBody({ wsId }: { wsId: number }) {
  const navigate = useNavigate()
  const historyQ = useHistory(wsId)
  const slowQ = useSlowQueries(wsId)
  const savedQ = useSavedQueries(wsId)
  const titles = useMemo(() => new Map((savedQ.data ?? []).map((q) => [q.id, q.title])), [savedQ.data])

  const open = (sql: string, savedQueryId?: number | null) =>
    navigate(`/w/${wsId}/data?tab=sql`, {
      state: {
        open: {
          sql,
          savedQueryId: savedQueryId && titles.has(savedQueryId) ? savedQueryId : null,
        } satisfies OpenInEditor,
      },
    })

  const runs = historyQ.data ?? []

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-8 sm:py-10">
      <StepHeader
        step="history"
        actions={
          <Link to={`/w/${wsId}/data?tab=sql`} className={buttonClass("secondary", "sm")}>
            <TerminalSquare size={14} />
            Open SQL
          </Link>
        }
      />

      {historyQ.isPending ? (
        <div className="grid min-h-[30dvh] place-items-center">
          <Spinner size={20} />
        </div>
      ) : historyQ.error ? (
        <EmptyState title="Couldn't load the history" lanes={[7, 3]}>
          {historyQ.error.message}
        </EmptyState>
      ) : runs.length === 0 ? (
        <EmptyState
          icon={<TerminalSquare size={18} strokeWidth={1.5} />}
          title="No queries run yet"
          action={
            <Link to={`/w/${wsId}/data?tab=sql`} className={buttonClass("primary")}>
              Write a query
            </Link>
          }
        >
          Every query you run, whether it works or fails, is recorded here with its timing.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-10">
          <section aria-labelledby="runs-h">
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h3 id="runs-h" className="text-[17px] font-medium tracking-[-0.01em] text-text">
                Runs
              </h3>
              <p className="text-[12.5px] text-muted">
                {runs.length === 100
                  ? "The latest 100 runs"
                  : `${fmtInt(runs.length)} ${runs.length === 1 ? "run" : "runs"}`}
                , newest first
              </p>
            </div>
            <RunsTable runs={runs} titles={titles} onOpen={open} />
          </section>

          <SlowQueries data={slowQ.data} pending={slowQ.isPending} onOpen={(sql) => open(sql)} />
        </div>
      )}
    </div>
  )
}

function Pill({ lane, children }: { lane: number; children: string }) {
  return (
    <span
      className="inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-[11.5px] font-medium"
      style={{ borderColor: laneAlpha(lane, 0.32), background: laneAlpha(lane, 0.08), color: laneVar(lane) }}
    >
      <span aria-hidden className="size-1.5 rounded-full" style={{ background: laneVar(lane) }} />
      {children}
    </span>
  )
}

function RunsTable({
  runs,
  titles,
  onOpen,
}: {
  runs: RunOut[]
  titles: Map<number, string>
  onOpen: (sql: string, savedQueryId: number | null) => void
}) {
  return (
    <div className="scrollbar-thin overflow-x-auto rounded-card border border-border bg-surface">
      <table className="w-full min-w-[760px] border-separate border-spacing-0 text-[13px]">
        <thead>
          <tr className="text-left text-[12px] text-muted">
            <th scope="col" className="border-b border-border bg-raised px-4 py-2.5 font-medium">
              When
            </th>
            <th scope="col" className="border-b border-border bg-raised px-3 py-2.5 font-medium">
              Source
            </th>
            <th scope="col" className="border-b border-border bg-raised px-3 py-2.5 font-medium">
              Status
            </th>
            <th scope="col" className="border-b border-border bg-raised px-3 py-2.5 text-right font-medium">
              Duration
            </th>
            <th scope="col" className="border-b border-border bg-raised px-3 py-2.5 text-right font-medium">
              Rows
            </th>
            <th scope="col" className="w-[48%] border-b border-border bg-raised px-4 py-2.5 font-medium">
              Query
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r, i) => {
            const src = SOURCE[r.source] ?? { label: r.source, lane: 0 }
            const st = STATUS[r.status] ?? { label: r.status, lane: 7 }
            const title = r.saved_query_id !== null ? titles.get(r.saved_query_id) : undefined
            return (
              <tr
                key={r.id}
                className="q-row-in group hover:bg-hover"
                // the first screenful arrives one row after another; capped so a long list doesn't crawl
                style={{ animationDelay: `${Math.min(i, 14) * 28}ms` }}
              >
                <td
                  className="whitespace-nowrap border-b border-border px-4 py-2.5 align-top text-muted"
                  title={absTime(r.created_at)}
                >
                  {fmtRelative(r.created_at)}
                </td>
                <td className="border-b border-border px-3 py-2.5 align-top">
                  <Pill lane={src.lane}>{src.label}</Pill>
                </td>
                <td className="border-b border-border px-3 py-2.5 align-top">
                  <Pill lane={st.lane}>{st.label}</Pill>
                </td>
                <td className="num whitespace-nowrap border-b border-border px-3 py-2.5 text-right align-top text-text">
                  {r.duration_ms === null ? <span className="text-faint">–</span> : fmtMs(r.duration_ms)}
                </td>
                <td className="num whitespace-nowrap border-b border-border px-3 py-2.5 text-right align-top text-text">
                  {r.row_count === null ? <span className="text-faint">–</span> : fmtInt(r.row_count)}
                </td>
                <td className="max-w-0 border-b border-border px-4 py-2 align-top">
                  <button
                    type="button"
                    onClick={() => onOpen(r.sql_text, r.saved_query_id)}
                    className="block w-full min-w-0 rounded-[6px] text-left"
                    title="Open in the editor"
                  >
                    {title && (
                      <span className="mb-0.5 block truncate text-[12.5px] font-medium text-text">{title}</span>
                    )}
                    <code className="block truncate font-mono text-[12.5px] text-muted transition-colors group-hover:text-text">
                      {snippet(r.sql_text)}
                    </code>
                    {r.error_message && r.status !== "ok" && (
                      <span className="mt-0.5 block truncate text-[12px]" style={{ color: laneVar(st.lane) }}>
                        {r.error_message}
                      </span>
                    )}
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * v_slow_queries: successful runs in the last 30 days at or above this workspace's 90th-percentile
 * duration. Each bar is the run's time against the slowest one, with a tick at the p90 line.
 */
function SlowQueries({
  data,
  pending,
  onOpen,
}: {
  data?: SlowQuery[]
  pending: boolean
  onOpen: (sql: string) => void
}) {
  const rows = data ?? []
  const max = Math.max(1e-9, ...rows.map((r) => r.duration_ms))
  const p90 = rows[0]?.p90_ms
  return (
    <section aria-labelledby="slow-h">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id="slow-h" className="flex items-center gap-2 text-[17px] font-medium tracking-[-0.01em] text-text">
          <Turtle size={17} strokeWidth={1.75} className="text-lane-3" />
          Slow queries
        </h3>
        <p className="max-w-[62ch] text-[12.5px] text-muted">
          Successful runs from the last 30 days that took as long as or longer than 90% of this workspace's runs
          {p90 !== undefined && (
            <>
              {" "}
              (<span className="num text-text">{fmtMs(p90)}</span> or more)
            </>
          )}
          .
        </p>
      </div>
      {pending ? (
        <Spinner size={16} />
      ) : rows.length === 0 ? (
        <p className="rounded-card border border-dashed border-border-strong px-4 py-6 text-center text-[13px] text-muted">
          No successful runs in the last 30 days yet, so there's nothing to compare.
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {rows.map((r, i) => (
            <li key={r.run_id} className="q-row-in" style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}>
              <button
                type="button"
                onClick={() => onOpen(r.sql_text)}
                title="Open in the editor"
                className="group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 rounded-card border border-border bg-surface px-4 py-3 text-left transition-colors hover:border-border-strong sm:grid-cols-[minmax(0,1fr)_220px_auto]"
              >
                <code className="col-span-2 truncate font-mono text-[12.5px] text-muted group-hover:text-text sm:col-span-1">
                  {snippet(r.sql_text)}
                </code>
                <span className="relative h-2 rounded-full bg-hover" aria-hidden>
                  <span
                    className="absolute inset-y-0 left-0 origin-left rounded-full bg-lane-3 [animation:q-bar_520ms_cubic-bezier(0.2,0.7,0.2,1)_both]"
                    style={{
                      width: `${Math.max(3, (r.duration_ms / max) * 100)}%`,
                      animationDelay: `${Math.min(i, 10) * 40 + 120}ms`,
                    }}
                  />
                  <span
                    className="absolute -inset-y-1 w-px bg-text opacity-50"
                    style={{ left: `${Math.min(100, (r.p90_ms / max) * 100)}%` }}
                    title="90th percentile"
                  />
                </span>
                <span className="flex items-baseline gap-3 justify-self-end">
                  <span className="num text-[13px] text-text">{fmtMs(r.duration_ms)}</span>
                  <span className="hidden text-[12px] text-faint sm:inline" title={absTime(r.created_at)}>
                    {fmtRelative(r.created_at)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
