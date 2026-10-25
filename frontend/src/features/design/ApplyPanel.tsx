import { TriangleAlert } from "lucide-react"
import { ApiError } from "../../lib/api"
import { fmtInt, fmtMs } from "../../lib/format"
import { laneVar } from "../../lib/lanes"
import { useCountUp } from "../../lib/reveal"
import type { Cell, LosslessFailure } from "../../lib/types"

export type AppliedSummary = {
  rows: number
  tables: { name: string; row_count: number; color_index: number }[]
  /** only known right after an apply in this session */
  durationMs: number | null
}

/** While the single apply request runs: everything it does happens in one transaction on the server. */
export function ApplyProgress({ tableCount, rows }: { tableCount: number; rows: number | null }) {
  return (
    <section aria-live="polite" className="er-rise rounded-card border border-border-strong bg-surface p-4">
      <p className="text-[14px] font-medium text-text">Applying the design</p>
      <div className="relative mt-3 h-[3px] overflow-hidden rounded-full bg-border">
        <span className="er-progress absolute inset-y-0 left-0 w-2/5 rounded-full bg-accent" />
      </div>
      <ul className="mt-3 space-y-1 text-[13px] text-muted">
        <li>
          Creating {tableCount} {tableCount === 1 ? "table" : "tables"}
        </li>
        <li>Copying {rows !== null ? <span className="num">{fmtInt(rows)}</span> : "the"} rows in</li>
        <li>Rebuilding the sheet from them and comparing it with the original</li>
      </ul>
      <p className="mt-3 text-[12.5px] text-faint">
        It all runs in one transaction, so a failed check changes nothing.
      </p>
    </section>
  )
}

/** The lossless proof: every sheet row came back from the new tables, none missing, none extra. */
export function AppliedResult({ summary }: { summary: AppliedSummary }) {
  const rows = useCountUp(summary.rows, true, 900)
  const total = summary.tables.length
  return (
    <section
      aria-labelledby="applied-h"
      className="er-rise rounded-card border p-4"
      style={{
        borderColor: "color-mix(in oklab, var(--lane-4) 35%, transparent)",
        background: "color-mix(in oklab, var(--lane-4) 6%, var(--surface))",
      }}
    >
      <h3 id="applied-h" className="flex items-center gap-2 text-[18px] font-semibold tracking-[-0.02em] text-text">
        Lossless
        <svg viewBox="0 0 24 24" className="er-check size-6 shrink-0" role="img" aria-label="check passed">
          <circle cx="12" cy="12" r="11" fill="color-mix(in oklab, var(--lane-4) 18%, transparent)" />
          <path
            d="M7 12.5l3.2 3.2L17 8.8"
            fill="none"
            stroke="var(--lane-4)"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={1}
          />
        </svg>
      </h3>
      <p className="mt-2 text-[15px] text-text">
        <span className="num">{fmtInt(Math.round(rows))}</span> rows rebuilt exactly
      </p>
      <p className="mt-1 text-[13px] leading-relaxed text-muted">
        Joining the {total} tables back together gives the original sheet row for row: none missing, none extra.
      </p>
      <ul className="mt-4 space-y-1.5">
        {summary.tables.map((t, i) => (
          <TableCount key={t.name} name={t.name} lane={t.color_index} rows={t.row_count} delay={i} />
        ))}
      </ul>
      <p className="mt-4 text-[12.5px] text-faint">
        {summary.durationMs !== null ? (
          <>
            Applied in <span className="num">{fmtMs(summary.durationMs)}</span>, checked with EXCEPT ALL both ways.
          </>
        ) : (
          "Checked with EXCEPT ALL both ways when it was applied."
        )}
      </p>
    </section>
  )
}

function TableCount({ name, lane, rows, delay }: { name: string; lane: number; rows: number; delay: number }) {
  const n = useCountUp(rows, true, 700 + delay * 120)
  return (
    <li className="flex items-center gap-2.5 text-[13px]">
      <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: laneVar(lane) }} />
      <span className="truncate font-mono text-[12.5px] text-text">{name}</span>
      <span aria-hidden className="mx-1 h-px flex-1 bg-border" />
      <span className="num text-muted">
        {fmtInt(Math.round(n))} {rows === 1 ? "row" : "rows"}
      </span>
    </li>
  )
}

/** Apply failed. A failed lossless check shows which rows differ; anything else shows the server's message. */
export function ApplyFailure({ error }: { error: Error }) {
  const lossless = error instanceof ApiError && error.code === "lossless_check_failed"
  const detail = lossless ? (error.detail as LosslessFailure | undefined) : undefined
  const sample = detail?.sample ?? []
  const cols = sample.length ? Object.keys(sample[0].row) : []
  return (
    <section
      role="alert"
      className="er-rise rounded-card border p-4"
      style={{
        borderColor: "color-mix(in oklab, var(--danger) 40%, transparent)",
        background: "color-mix(in oklab, var(--danger) 6%, var(--surface))",
      }}
    >
      <div className="flex items-center gap-2 text-danger">
        <TriangleAlert size={16} strokeWidth={2} />
        <h3 className="text-[14.5px] font-semibold">
          {lossless ? "The lossless check failed" : "Couldn't apply the design"}
        </h3>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{error.message}</p>
      {detail && (
        <p className="mt-1 text-[13px] text-muted">
          <span className="num text-text">{fmtInt(detail.missing_rows ?? 0)}</span> missing,{" "}
          <span className="num text-text">{fmtInt(detail.extra_rows ?? 0)}</span> extra in the rebuilt sheet. A few of
          them:
        </p>
      )}
      {sample.length > 0 && (
        <div className="scrollbar-thin mt-3 overflow-x-auto rounded-control border border-border bg-bg">
          <table className="w-full border-collapse font-mono text-[11.5px]">
            <thead>
              <tr className="text-left text-muted">
                <th className="px-2 py-1.5 font-normal">row</th>
                {cols.map((c) => (
                  <th key={c} className="whitespace-nowrap px-2 py-1.5 font-normal">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sample.map((s, i) => (
                <tr key={i} className="border-t border-border">
                  <td
                    className="whitespace-nowrap px-2 py-1.5"
                    style={{ color: s.side === "missing" ? "var(--danger)" : "var(--lane-3)" }}
                  >
                    {s.side === "missing" ? "missing" : "extra"}
                  </td>
                  {cols.map((c) => (
                    <td key={c} className="whitespace-nowrap px-2 py-1.5 text-text">
                      <CellText v={s.row[c]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function CellText({ v }: { v: Cell | undefined }) {
  if (v === null || v === undefined) return <span className="text-faint">NULL</span>
  return <>{String(v)}</>
}
