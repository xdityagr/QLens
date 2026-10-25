import { ArrowRight, ListTree } from "lucide-react"
import { useState } from "react"
import { Button } from "../../components/Button"
import { fmtMs } from "../../lib/format"
import { laneAlpha, laneVar } from "../../lib/lanes"
import { relationOf, speedupLabel, type PlanOut } from "../../lib/plan"
import { useCountUp } from "../../lib/reveal"
import type { ExperimentOut } from "./api"
import { PlanSteps } from "./PlanSteps"

/** How a plan read `table`: its own scan step (the Bitmap Heap Scan over a Bitmap Index Scan, or the plain scan). */
function scanOf(plan: PlanOut, table: string, tableOfIndex: Record<string, string>): string | null {
  const own = plan.nodes.find((n) => n.relation === table)
  if (own) return own.node_type
  return plan.nodes.find((n) => relationOf(n, tableOfIndex) === table)?.node_type ?? null
}

/** "×37 faster", counting up from ×1 once it lands; "About the same" / "×N slower" are shown as they are. */
function Speedup({ speedup }: { speedup: number | null }) {
  const faster = speedup !== null && speedup >= 1.1
  const climbed = useCountUp(faster ? speedup - 1 : 0, faster, 900)
  if (!faster) return <>{speedupLabel(speedup)}</>
  const v = climbed + 1
  return <>×{speedup >= 10 ? Math.round(v) : v.toFixed(1)} faster</>
}

/**
 * The result of a speed test: the query's median time without and with the index as two bars on one
 * scale, the speedup, how the table's scan changed, and (on request) both plans side by side.
 */
export function BeforeAfter({
  experiment,
  note,
  laneOf,
  tableOfIndex,
}: {
  experiment: ExperimentOut
  /** one line on where this was measured */
  note: string
  laneOf: (table: string) => number | null
  tableOfIndex: Record<string, string>
}) {
  const [both, setBoth] = useState(false)
  const lane = laneOf(experiment.table) ?? 0
  const { before_ms, after_ms, speedup } = experiment
  const max = Math.max(before_ms, after_ms, 0.001)
  const beforeScan = scanOf(experiment.before_plan, experiment.table, tableOfIndex)
  const afterScan = scanOf(experiment.after_plan, experiment.table, tableOfIndex)
  const bars = [
    { key: "before", label: "Without the index", ms: before_ms, color: laneAlpha(lane, 0.4) },
    { key: "after", label: "With the index", ms: after_ms, color: laneVar(lane) },
  ]

  return (
    <section aria-label="Speed test result" className="ba-pop rounded-card border border-border bg-surface">
      <div className="flex flex-col gap-4 px-4 py-4">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
          <p
            className="text-[40px] font-medium leading-none tracking-[-0.04em] text-text"
            aria-live="polite"
            aria-label={speedupLabel(speedup)}
          >
            <Speedup speedup={speedup} />
          </p>
          <p className="text-[12.5px] text-muted">
            with an index on{" "}
            <span className="font-mono text-text">
              {experiment.table} ({experiment.columns.join(", ")})
            </span>
          </p>
        </div>

        {/* two bars on one scale: same baseline, length = median time; the value rides the tip */}
        <div className="flex flex-col gap-2" role="list" aria-label="Query time without and with the index">
          {bars.map((b, i) => (
            <div
              key={b.key}
              role="listitem"
              className="grid grid-cols-[112px_minmax(0,1fr)] items-center gap-3"
              title={`${b.label}: ${fmtMs(b.ms)} (median of ${experiment.runs} runs)`}
            >
              <span className="text-[12.5px] text-muted">{b.label}</span>
              <div className="flex min-w-0 items-center gap-2.5">
                <div
                  className="ba-bar shrink-0"
                  style={{
                    // 84px stays free for the label, so the longest bar still fits it
                    width: `max(3px, calc((100% - 84px) * ${b.ms / max}))`,
                    background: b.color,
                    animationDelay: `${120 + i * 260}ms`,
                  }}
                />
                <span
                  className="ba-pop shrink-0 font-mono text-[13px] tabular-nums text-text"
                  style={{ animationDelay: `${420 + i * 260}ms` }}
                >
                  {fmtMs(b.ms)}
                </span>
              </div>
            </div>
          ))}
        </div>

        {beforeScan && afterScan && beforeScan !== afterScan && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
            <span className="text-muted">PostgreSQL switched from</span>
            <span className="font-medium text-text">{beforeScan}</span>
            <ArrowRight size={13} className="text-faint" aria-label="to" />
            <span className="font-medium text-text">{afterScan}</span>
          </p>
        )}
        <p className="text-[12.5px] leading-relaxed text-muted">{note}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-2">
        <p className="mr-auto text-[12px] text-faint">Median of {experiment.runs} runs each</p>
        <Button
          size="sm"
          variant={both ? "secondary" : "ghost"}
          icon={<ListTree size={13} />}
          aria-pressed={both}
          aria-expanded={both}
          onClick={() => setBoth((v) => !v)}
        >
          {both ? "Hide both plans" : "Compare both plans"}
        </Button>
      </div>

      {both && (
        <div className="perf-in grid gap-4 border-t border-border p-3 @3xl:grid-cols-2">
          {(
            [
              ["Without the index", experiment.before_plan],
              ["With the index", experiment.after_plan],
            ] as const
          ).map(([title, plan]) => (
            <div key={title} className="min-w-0">
              <p className="mb-1 flex items-baseline justify-between gap-3 px-2 text-[13px]">
                <span className="font-medium text-text">{title}</span>
                <span className="font-mono text-[12px] text-muted">ran in {fmtMs(plan.execution_ms)}</span>
              </p>
              <PlanSteps
                plan={plan}
                laneOf={laneOf}
                tableOfIndex={tableOfIndex}
                label={`Query plan ${title.toLowerCase()}`}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
