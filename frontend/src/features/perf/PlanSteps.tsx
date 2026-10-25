import { AlertTriangle, Flame } from "lucide-react"
import type { CSSProperties } from "react"
import { fmtInt, fmtMs } from "../../lib/format"
import { laneVar } from "../../lib/lanes"
import {
  conditionOf,
  heat,
  misestimate,
  MISESTIMATE_WARN,
  relationOf,
  stepSentence,
  toTree,
  type PlanOut,
  type PlanTreeNode,
} from "../../lib/plan"

function fmtFactor(f: number): string {
  return f >= 10 ? fmtInt(f) : f.toFixed(1)
}

interface Ctx {
  maxSelf: number
  hottestId: number | null
  laneOf: (table: string) => number | null
  tableOfIndex: Record<string, string>
}

/**
 * A plan as a top-down tree of plain sentences: the result on top, the steps that feed it indented below.
 * Each step says what it does and to which table, the rows it passed up and its own time; the slowest step
 * is highlighted. It grows in from the top, one step after another.
 */
export function PlanSteps({
  plan,
  laneOf,
  tableOfIndex,
  label,
}: {
  plan: PlanOut
  laneOf: (table: string) => number | null
  tableOfIndex: Record<string, string>
  label: string
}) {
  if (plan.nodes.length === 0) return null
  const tree = toTree(plan.nodes)
  const maxSelf = Math.max(0, ...plan.nodes.map((n) => n.self_ms))
  // one step is trivially the slowest; only a real choice gets the highlight
  const hottest =
    maxSelf > 0 && plan.nodes.length > 1 ? plan.nodes.reduce((a, b) => (b.self_ms > a.self_ms ? b : a)) : null
  const ctx: Ctx = { maxSelf, hottestId: hottest?.id ?? null, laneOf, tableOfIndex }
  return (
    <ul className="ex-tree" aria-label={label}>
      <Step t={tree} ctx={ctx} />
    </ul>
  )
}

function Step({ t, ctx }: { t: PlanTreeNode; ctx: Ctx }) {
  const n = t.node
  const table = relationOf(n, ctx.tableOfIndex)
  const lane = table ? ctx.laneOf(table) : null
  const cond = conditionOf(n)
  const off = misestimate(n)
  const rows = n.actual_rows * n.loops
  const hot = n.id === ctx.hottestId && ctx.maxSelf > 0
  const style = {
    "--ex-order": n.id,
    "--ex-heat": Math.max(heat(n, ctx.maxSelf), 0.02),
  } as CSSProperties

  return (
    <li>
      <div className="ex-step" data-hot={hot || undefined} style={style}>
        <span
          aria-hidden
          className="ex-dot"
          style={lane === null ? undefined : { background: laneVar(lane), boxShadow: "none" }}
        />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] leading-snug text-text">
            {stepSentence(n, ctx.tableOfIndex)}{" "}
            <span className="whitespace-nowrap font-mono text-[11.5px] text-faint">({n.node_type})</span>
            {hot && (
              <span className="ex-hot-tag ml-2 align-[1px]">
                <Flame size={11} strokeWidth={2} aria-hidden />
                slowest step
              </span>
            )}
          </p>
          {(cond || off >= MISESTIMATE_WARN) && (
            <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]">
              {cond && (
                <span className="min-w-0 truncate" title={`${cond.label} ${cond.text}`}>
                  <span className="text-faint">{cond.label} </span>
                  <span className="font-mono text-muted">{cond.text}</span>
                </span>
              )}
              {off >= MISESTIMATE_WARN && (
                <span
                  className="ex-warn"
                  title="PostgreSQL plans with row-count guesses from its statistics. A guess this far off can make it pick a slow plan; running ANALYZE on the table usually fixes it."
                >
                  <AlertTriangle size={10.5} strokeWidth={2.25} aria-hidden />
                  guessed {fmtInt(n.est_rows)} rows, got {fmtInt(n.actual_rows)} (×{fmtFactor(off)} off)
                </span>
              )}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
          <span className="font-mono text-[12.5px] tabular-nums text-text">
            <span className="text-muted">
              {fmtInt(rows)} {rows === 1 ? "row" : "rows"},{" "}
            </span>
            {fmtMs(n.self_ms)}
          </span>
          <span
            className="ex-heat"
            role="img"
            aria-label={`${Math.round(n.pct_of_total)}% of the query's time is spent in this step`}
            title={`${Math.round(n.pct_of_total)}% of the time${t.children.length ? `; ${fmtMs(n.total_ms)} with the steps below it` : ""}`}
          >
            <span className="ex-heat-fill" />
          </span>
        </div>
      </div>
      {t.children.length > 0 && (
        <ul className="ex-children">
          {t.children.map((c) => (
            <Step key={c.node.id} t={c} ctx={ctx} />
          ))}
        </ul>
      )}
    </li>
  )
}
