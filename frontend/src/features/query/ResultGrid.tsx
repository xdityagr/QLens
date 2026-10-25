import { AlertTriangle, Ban, Clock, Info, TerminalSquare } from "lucide-react"
import type { ReactNode } from "react"
import { DataGrid, type GridColumn } from "../../components/DataGrid"
import { fmtInt, fmtMs } from "../../lib/format"
import { laneAlpha, laneVar } from "../../lib/lanes"
import { useCountUp } from "../../lib/reveal"
import type { ErrorLocation } from "../../lib/sqlText"
import type { QueryErrorCode, QueryResult } from "./api"

export type RunOutcome =
  | { kind: "ok"; runId: number; result: QueryResult; tables: { name: string; lane: number | null }[] }
  | { kind: "error"; key: number; code: string; message: string; sqlstate?: string | null; where: ErrorLocation | null }

const NUMERIC = /^(smallint|integer|bigint|numeric|real|double precision|money)\b/

/** Results of the last run: rows, or what went wrong and where. Previous results stay up while a new run is in flight. */
export function ResultPanel({
  outcome,
  running,
  runHint,
}: {
  outcome: RunOutcome | null
  running: boolean
  runHint: string
}) {
  return (
    <section aria-label="Results" aria-busy={running} className="relative min-w-0">
      {/* a thin sweep while the query runs; the old rows stay put underneath */}
      <div aria-hidden className={`q-progress ${running ? "q-progress-on" : ""}`} />
      {outcome === null ? (
        <div className="grid min-h-[200px] place-items-center rounded-card border border-dashed border-border-strong px-6 py-10 text-center">
          <div className="max-w-sm">
            <TerminalSquare size={20} strokeWidth={1.5} className="mx-auto mb-3 text-faint" />
            <p className="text-[14px] text-muted">
              Rows show up here. Press <kbd className="kbd">{runHint}</kbd> or Run.
            </p>
          </div>
        </div>
      ) : outcome.kind === "ok" ? (
        <OkResult key={outcome.runId} outcome={outcome} dim={running} />
      ) : (
        <ErrorResult key={outcome.key} outcome={outcome} />
      )}
    </section>
  )
}

function OkResult({ outcome, dim }: { outcome: Extract<RunOutcome, { kind: "ok" }>; dim: boolean }) {
  const { result, tables } = outcome
  const shown = useCountUp(result.row_count, true, 520)
  const columns: GridColumn[] = result.columns.map((c) => ({
    name: c.name,
    type: c.type,
    numeric: NUMERIC.test(c.type),
  }))
  return (
    <div className={`q-result transition-opacity duration-200 ${dim ? "opacity-60" : ""}`}>
      <div className="mb-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 px-0.5">
        <p className="text-[14px] text-text">
          <span className="num font-medium">{fmtInt(shown)}</span>{" "}
          <span className="text-muted">{result.row_count === 1 ? "row" : "rows"}</span>
          <span className="text-muted"> in </span>
          <span className="num">{fmtMs(result.duration_ms)}</span>
        </p>
        {tables.length > 0 && (
          <p className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted">
            <span>Read from</span>
            {tables.map((tb) => (
              <span
                key={tb.name}
                className="inline-flex h-[22px] items-center gap-1.5 rounded-full border px-2 font-mono text-[11.5px]"
                style={
                  tb.lane === null
                    ? { borderColor: "var(--border-strong)", color: "var(--muted)" }
                    : {
                        borderColor: laneAlpha(tb.lane, 0.35),
                        background: laneAlpha(tb.lane, 0.08),
                        color: laneVar(tb.lane),
                      }
                }
              >
                <span
                  aria-hidden
                  className="size-1.5 rounded-full"
                  style={
                    tb.lane === null
                      ? { boxShadow: "inset 0 0 0 1.25px var(--muted)" }
                      : { background: laneVar(tb.lane) }
                  }
                />
                {tb.name}
              </span>
            ))}
          </p>
        )}
      </div>
      {result.truncated && (
        <p className="mb-2.5 flex items-start gap-2 rounded-control border border-[color-mix(in_oklab,var(--lane-3)_35%,transparent)] bg-[color-mix(in_oklab,var(--lane-3)_8%,transparent)] px-3 py-2 text-[13px] text-text">
          <Info size={15} className="mt-0.5 shrink-0 text-lane-3" />
          <span>
            More than {fmtInt(result.row_count)} rows matched, so only the first {fmtInt(result.row_count)} are shown.
            Narrow the query with WHERE, or aggregate with GROUP BY, to see everything that matters.
          </span>
        </p>
      )}
      {result.columns.length === 0 ? (
        <p className="rounded-card border border-border bg-surface px-4 py-6 text-center text-[13px] text-muted">
          The query ran but returns no columns.
        </p>
      ) : (
        <DataGrid columns={columns} rows={result.rows} maxHeight="min(560px, 60vh)" />
      )}
    </div>
  )
}

const ERROR_COPY: Record<QueryErrorCode, { title: string; hint?: string; icon: ReactNode }> = {
  timeout: {
    title: "Stopped after 5 seconds",
    hint: "Each query here gets at most 5 seconds; PostgreSQL cancelled this one when it ran past that. Narrow it with a WHERE clause, join on keys, or add a LIMIT.",
    icon: <Clock size={16} />,
  },
  db_error: { title: "PostgreSQL couldn't run this query", icon: <AlertTriangle size={16} /> },
  syntax_error: { title: "Syntax error", icon: <AlertTriangle size={16} /> },
  not_a_select: {
    title: "Not a plain SELECT",
    hint: "The query screen is read-only: it reads your tables but never changes them.",
    icon: <Ban size={16} />,
  },
  multiple_statements: {
    title: "More than one statement",
    hint: "Run each statement on its own. The mark shows where the second one starts.",
    icon: <Ban size={16} />,
  },
  forbidden_function: {
    title: "Blocked function",
    hint: "Functions that touch the server itself (files, settings, other sessions) are blocked in the sandbox.",
    icon: <Ban size={16} />,
  },
}

function ErrorResult({ outcome }: { outcome: Extract<RunOutcome, { kind: "error" }> }) {
  const copy = ERROR_COPY[outcome.code as QueryErrorCode] ?? {
    title: "The query failed",
    icon: <AlertTriangle size={16} />,
  }
  const tone = outcome.code === "timeout" ? 3 : 7
  const { where } = outcome
  return (
    <div
      role="alert"
      className="q-result rounded-card border bg-surface p-4"
      style={{ borderColor: laneAlpha(tone, 0.4) }}
    >
      <div className="flex items-start gap-3">
        <span
          className="grid size-8 shrink-0 place-items-center rounded-full"
          style={{ color: laneVar(tone), background: laneAlpha(tone, 0.12) }}
        >
          {copy.icon}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-medium text-text">{copy.title}</h3>
          <p className="mt-1 break-words font-mono text-[12.5px] leading-relaxed text-text">{outcome.message}</p>
          {where && (
            <pre className="scrollbar-thin mt-3 overflow-x-auto rounded-control border border-border bg-bg px-3 py-2 font-mono text-[12.5px] leading-relaxed">
              <span className="select-none text-faint">{`line ${where.line} │ `}</span>
              <span className="text-text">{where.lineText.replace(/	/g, " ")}</span>
              {"\n"}
              <span className="select-none text-faint">
                {" ".repeat(`line ${where.line} │ `.length + where.column - 1)}
              </span>
              <span className="font-semibold" style={{ color: laneVar(7) }}>
                ^
              </span>
            </pre>
          )}
          {copy.hint && <p className="mt-3 text-[13px] leading-relaxed text-muted">{copy.hint}</p>}
          {outcome.sqlstate && (
            <p className="mt-2 text-[12px] text-faint">
              SQLSTATE <span className="font-mono">{outcome.sqlstate}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
