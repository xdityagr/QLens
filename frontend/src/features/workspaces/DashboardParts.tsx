import { ArrowUpRight, Database, FileSpreadsheet, Rows3, Table2, TerminalSquare } from "lucide-react"
import type { ReactNode } from "react"
import { Link } from "react-router"
import { Badge } from "../../components/Badge"
import { buttonClass } from "../../components/buttonClass"
import { NoiseBackdrop } from "../../components/NoiseBackdrop"
import { Spinner } from "../../components/Spinner"
import { fmtInt, fmtRelative } from "../../lib/format"
import { laneAlpha, laneVar } from "../../lib/lanes"
import { useCountUp } from "../../lib/reveal"
import { STAGE_META, nextStep, stepStates } from "../../lib/steps"
import type { WorkspaceOut } from "../../lib/types"
import { activityLine, touchedAt, type DashboardStats } from "./dashboard"
import { SAMPLES, type SampleMeta } from "./useTrySample"

function Count({ value }: { value: number }) {
  const v = useCountUp(value, true, 900)
  return <>{fmtInt(v)}</>
}

const TILES: { key: keyof DashboardStats; label: string; lane: number; icon: ReactNode }[] = [
  { key: "workspaces", label: "Workspaces", lane: 0, icon: <Database size={14} strokeWidth={1.75} /> },
  { key: "sheets", label: "Sheets imported", lane: 1, icon: <FileSpreadsheet size={14} strokeWidth={1.75} /> },
  { key: "rows", label: "Rows imported", lane: 5, icon: <Rows3 size={14} strokeWidth={1.75} /> },
  { key: "tables", label: "Tables created", lane: 4, icon: <Table2 size={14} strokeWidth={1.75} /> },
  { key: "queries", label: "Queries run", lane: 3, icon: <TerminalSquare size={14} strokeWidth={1.75} /> },
]

export function StatsRow({ stats }: { stats: DashboardStats }) {
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-border bg-border sm:grid-cols-3 lg:grid-cols-5">
      {TILES.map((t, i) => (
        <div key={t.key} className={`relative bg-surface px-5 pb-5 pt-4 ${i === 0 ? "col-span-2 sm:col-span-1" : ""}`}>
          <span aria-hidden className="absolute inset-x-5 top-0 h-[2px] rounded-b-full" style={{ background: laneVar(t.lane) }} />
          <dt className="flex items-center gap-2 text-[13px] text-muted">
            <span style={{ color: laneVar(t.lane) }}>{t.icon}</span>
            {t.label}
          </dt>
          <dd className="num mt-2 text-[28px] leading-none tracking-[-0.03em] text-text">
            <Count value={stats[t.key]} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** The six steps with labels, at a size that reads on its own. */
function LabeledRail({ ws }: { ws: WorkspaceOut }) {
  const steps = stepStates(ws.stage)
  return (
    <ol className="flex items-start" aria-label="Progress">
      {steps.map((s, i) => {
        const lit = s.state !== "locked" && steps[i + 1] && steps[i + 1].state !== "locked"
        return (
          <li key={s.key} className="relative flex min-w-0 flex-1 flex-col items-start" aria-current={s.state === "current" ? "step" : undefined}>
            <div className="flex w-full items-center">
              {s.state === "done" ? (
                <span className="size-[10px] shrink-0 rounded-full bg-accent" />
              ) : s.state === "current" ? (
                <span className="grid size-[14px] shrink-0 place-items-center rounded-full border-2 border-accent" style={{ boxShadow: `0 0 0 4px ${laneAlpha(0, 0.18)}` }}>
                  <span className="size-[4px] rounded-full bg-accent" />
                </span>
              ) : s.state === "open" ? (
                <span className="size-[10px] shrink-0 rounded-full border-2 border-accent" />
              ) : (
                <span className="size-[10px] shrink-0 rounded-full border-[1.5px] border-faint" />
              )}
              {i < steps.length - 1 && (
                <span
                  className="mx-1.5 h-0 flex-1"
                  style={lit ? { borderTop: "2px solid var(--accent)" } : { borderTop: "2px dashed var(--border-strong)" }}
                />
              )}
            </div>
            <span
              className={`mt-2 truncate pr-2 text-[12px] ${s.state === "current" ? "text-text" : `hidden sm:block ${s.state === "locked" ? "text-faint" : "text-muted"}`}`}
            >
              {s.label}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

export function ContinueCard({ ws }: { ws: WorkspaceOut }) {
  const meta = STAGE_META[ws.stage]
  const next = stepStates(ws.stage).find((s) => s.state === "current")!
  const lane = meta.lane ?? 0
  return (
    <section aria-labelledby="continue-h" className="relative isolate overflow-hidden rounded-card border border-border bg-surface">
      <NoiseBackdrop lanes={[lane, 1]} intensity={0.14} placement="top" />
      <div className="relative flex flex-col gap-6 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p id="continue-h" className="text-[13px] text-muted">
              Continue where you left off
            </p>
            <h2 className="mt-1 truncate text-[26px] font-medium leading-tight tracking-[-0.035em] text-text">{ws.name}</h2>
            <p className="mt-1 text-[13px] text-faint">
              {activityLine(ws)}, <time dateTime={ws.last_activity_at ?? ws.created_at}>{fmtRelative(ws.last_activity_at ?? ws.created_at)}</time>
            </p>
          </div>
          <Badge lane={meta.lane}>{meta.label}</Badge>
        </div>
        <LabeledRail ws={ws} />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="max-w-[52ch] text-[14px] text-muted">{next.blurb}</p>
          <Link to={`/w/${ws.id}/${nextStep(ws.stage)}`} className={buttonClass("primary")}>
            {ws.stage === "applied" ? "Open Query" : `Continue to ${next.label}`}
          </Link>
        </div>
      </div>
    </section>
  )
}

export function SamplesPanel({
  onTry,
  pending,
  error,
  compact = false,
}: {
  onTry: (s: SampleMeta) => void
  pending: SampleMeta["name"] | null
  error?: string | null
  compact?: boolean
}) {
  return (
    <section aria-labelledby="samples-h" className={compact ? "" : "rounded-card border border-border bg-surface p-5"}>
      <h2 id="samples-h" className="text-[15px] font-medium tracking-[-0.015em] text-text">
        Try a sample
      </h2>
      <p className="mt-1 text-[13px] text-muted">A new workspace with a bundled sheet, opened at Analyze.</p>
      <ul className="mt-4 flex flex-col gap-2">
        {SAMPLES.map((s) => (
          <li key={s.name}>
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => onTry(s)}
              className="group flex w-full items-center gap-3 rounded-control border border-border bg-raised px-3 py-2.5 text-left transition-[border-color,background-color] duration-150 hover:border-border-strong hover:bg-hover disabled:cursor-wait disabled:opacity-70"
            >
              <span className="h-8 w-[3px] shrink-0 rounded-full" style={{ background: laneVar(s.lane) }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] text-text">{s.title}</span>
                <span className="block text-[12.5px] leading-snug text-muted">
                  {s.blurb}, <span className="num">{fmtInt(s.rows)}</span> rows
                </span>
              </span>
              {pending === s.name ? (
                <Spinner size={14} />
              ) : (
                <ArrowUpRight size={16} strokeWidth={1.75} className="text-faint transition-colors group-hover:text-text" />
              )}
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="mt-3 text-[13px] text-danger">
          {error}
        </p>
      )}
    </section>
  )
}

export function ActivityList({ workspaces }: { workspaces: WorkspaceOut[] }) {
  const items = [...workspaces].sort((a, b) => touchedAt(b) - touchedAt(a)).slice(0, 6)
  return (
    <section aria-labelledby="activity-h" className="rounded-card border border-border bg-surface p-5">
      <h2 id="activity-h" className="text-[15px] font-medium tracking-[-0.015em] text-text">
        Recent activity
      </h2>
      <ol className="relative mt-4">
        {/* the lane running through the list */}
        <span aria-hidden className="absolute bottom-3 left-[4px] top-2 w-[2px] rounded-full bg-border-strong" />
        {items.map((w) => {
          const lane = STAGE_META[w.stage].lane
          const when = w.last_activity_at ?? w.created_at
          return (
            <li key={w.id} className="relative flex gap-3 pb-4 last:pb-0">
              <span
                aria-hidden
                className="relative mt-[5px] size-[10px] shrink-0 rounded-full"
                style={
                  lane === null
                    ? { background: "var(--surface)", border: "1.5px solid var(--faint)" }
                    : { background: laneVar(lane), boxShadow: "0 0 0 3px var(--surface)" }
                }
              />
              <div className="min-w-0 flex-1">
                <Link to={`/w/${w.id}/${nextStep(w.stage)}`} className="block truncate text-[14px] text-text hover:underline">
                  {w.name}
                </Link>
                <p className="truncate text-[12.5px] text-muted">{activityLine(w)}</p>
              </div>
              <time dateTime={when} className="shrink-0 pt-0.5 text-[12px] text-faint">
                {fmtRelative(when)}
              </time>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
