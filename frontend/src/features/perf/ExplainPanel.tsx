import "./perf.css"
import { AlertTriangle, Check, Lightbulb, MoreHorizontal, RefreshCw, RotateCcw, X, Zap } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button, IconButton } from "../../components/Button"
import { CodeBlock } from "../../components/CodeBlock"
import { Spinner } from "../../components/Spinner"
import { ApiError } from "../../lib/api"
import { fmtInt, fmtMs } from "../../lib/format"
import { relationOf, suggestionText, type PlanOut } from "../../lib/plan"
import { useAppliedSchema } from "../../lib/schema"
import { locateError } from "../../lib/sqlText"
import type { QueryErrorDetail } from "../query/api"
import type { IndexSuggestion, LabOut } from "./api"
import { BeforeAfter } from "./BeforeAfter"
import { PlanSteps } from "./PlanSteps"
import { useExplain, useResetLab, useSpeedTest, type SpeedTestPhase } from "./queries"

export interface ExplainPanelProps {
  wsId: number
  /** the SELECT to explain; it runs once (read-only) against the real tables */
  sql: string
  /** shows a close button when given */
  onClose?: () => void
  className?: string
}

const ERROR_TITLE: Record<string, string> = {
  timeout: "Stopped after 5 seconds",
  db_error: "PostgreSQL couldn't run this query",
  syntax_error: "Syntax error",
  not_a_select: "Only a SELECT can be explained",
  multiple_statements: "More than one statement",
  forbidden_function: "Blocked function",
  invalid_query: "Couldn't check this query",
  query_too_complex: "Too large or too deeply nested",
}

const quoteIdent = (s: string) => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`)

/** The statement that would add the index to the real tables (PostgreSQL names it). */
function realDdl(s: IndexSuggestion): string {
  return `CREATE INDEX ON ${quoteIdent(s.table)} (${s.columns.map(quoteIdent).join(", ")});`
}

const keyOf = (s: IndexSuggestion) => `${s.table}(${s.columns.join(",")})`

/** Where the timing was done, in one line. */
function measuredNote(lab: LabOut): string {
  const biggest = [...lab.tables].sort((a, b) => b.row_count - a.row_count)[0]
  if (lab.scale_factor > 1 && biggest) {
    return (
      `Measured on a test copy of your tables with ${biggest.name} grown ${fmtInt(lab.scale_factor)}× ` +
      `(${fmtInt(biggest.row_count)} rows), so the difference is easy to see. Your real tables were not touched.`
    )
  }
  return "Measured on a test copy of your tables. Your real tables were not touched."
}

/**
 * "Explain & speed up" for one query, meant to sit next to a query the user just ran. It explains the query
 * on the real tables and shows the plan as plain sentences, then the advisor's index suggestion with
 * "Test the speed-up", which times the query with and without that index on a larger test copy.
 */
export function ExplainPanel({ wsId, sql, onClose, className = "" }: ExplainPanelProps) {
  const explainQ = useExplain(wsId, sql)
  const schemaQ = useAppliedSchema(wsId)
  const test = useSpeedTest(wsId)
  const reset = useResetLab(wsId)
  const [notice, setNotice] = useState<string | null>(null)

  // a speed test belongs to the SQL it timed; a new query starts over
  const current = test.variables?.sql === sql
  const testing = current && test.variables ? keyOf(test.variables.suggestion) : null
  const result = current ? test.data : undefined

  const lanes = useMemo(() => new Map((schemaQ.data?.tables ?? []).map((t) => [t.name, t.color_index])), [schemaQ.data])
  const laneOf = useCallback((name: string) => lanes.get(name) ?? null, [lanes])
  const tableOfIndex = useMemo(() => {
    const m: Record<string, string> = {}
    for (const t of schemaQ.data?.tables ?? []) for (const i of t.indexes) m[i.name] = t.name
    if (result) {
      for (const t of result.lab.tables) for (const i of t.indexes) m[i.name] = t.name
    }
    return m
  }, [schemaQ.data, result])

  function runTest(s: IndexSuggestion) {
    setNotice(null)
    test.mutate({ sql, suggestion: s })
  }

  const busy = test.isPending || reset.isPending
  const data = explainQ.data

  return (
    <section
      aria-label="Explain and speed up"
      className={`@container flex flex-col overflow-hidden rounded-card border border-border bg-surface ${className}`}
    >
      <header className="flex items-start gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-medium tracking-[-0.01em] text-text">Explain &amp; speed up</h3>
          <p className="mt-0.5 text-[12.5px] text-muted">
            {data ? (
              <>
                How PostgreSQL ran this query:{" "}
                <span className="font-mono text-text">{fmtMs(data.plan.execution_ms)}</span>, plus{" "}
                <span className="font-mono">{fmtMs(data.plan.planning_ms)}</span> to plan it
              </>
            ) : (
              "How PostgreSQL runs this query, step by step"
            )}
          </p>
        </div>
        <OverflowMenu
          disabled={busy || explainQ.isFetching}
          onExplainAgain={() => void explainQ.refetch()}
          onReset={() =>
            reset.mutate(undefined, {
              onSuccess: () => {
                test.reset()
                setNotice("The test copy is back to your tables' real size, without the test indexes.")
              },
              onError: (e) => setNotice(e.message),
            })
          }
        />
        {onClose && (
          <IconButton label="Close" onClick={onClose} className="-mr-1.5 size-7">
            <X size={15} strokeWidth={1.75} />
          </IconButton>
        )}
      </header>

      <div className="flex flex-col gap-4 p-3 sm:p-4">
        {explainQ.isPending || (explainQ.isFetching && !data) ? (
          <div className="flex items-center gap-2.5 px-1 py-6 text-[13px] text-muted" aria-live="polite">
            <Spinner size={14} />
            Running the query once to see its plan…
          </div>
        ) : explainQ.error ? (
          <ExplainError error={explainQ.error} sql={sql} />
        ) : data ? (
          <>
            <PlanSteps
              key={data.run_id}
              plan={data.plan}
              laneOf={laneOf}
              tableOfIndex={tableOfIndex}
              label="Query plan: the result on top, the steps that feed it below"
            />

            <Suggestions
              plan={data.plan}
              suggestions={data.suggestions}
              tableOfIndex={tableOfIndex}
              testing={testing}
              tested={result ? keyOf(test.variables!.suggestion) : null}
              phase={test.phase}
              growBy={test.growBy}
              disabled={busy}
              error={current && test.error ? test.error.message : null}
              onTest={runTest}
            />

            {result && (
              <BeforeAfter
                key={result.experiment.id}
                experiment={result.experiment}
                note={measuredNote(result.lab)}
                laneOf={laneOf}
                tableOfIndex={tableOfIndex}
              />
            )}
          </>
        ) : null}

        {notice && (
          <p role="status" className="perf-in text-[12.5px] text-muted">
            {notice}
          </p>
        )}
      </div>
    </section>
  )
}

const PHASE_TEXT: Record<SpeedTestPhase, (growBy: number | null) => string> = {
  copy: () => "Making a test copy of your tables…",
  grow: (f) => `Growing the test copy ${f ?? ""}× so the difference is easy to see…`,
  time: () => "Timing the query 5 times without the index, then 5 times with it…",
}

function Suggestions({
  plan,
  suggestions,
  tableOfIndex,
  testing,
  tested,
  phase,
  growBy,
  disabled,
  error,
  onTest,
}: {
  plan: PlanOut
  suggestions: IndexSuggestion[]
  tableOfIndex: Record<string, string>
  testing: string | null
  /** the suggestion whose result is showing */
  tested: string | null
  phase: SpeedTestPhase | null
  growBy: number | null
  disabled: boolean
  error: string | null
  onTest: (s: IndexSuggestion) => void
}) {
  if (suggestions.length === 0) {
    const usesIndex = plan.nodes.some((n) => n.index_name && relationOf(n, tableOfIndex))
    return (
      <p className="perf-in flex items-start gap-2 rounded-control border border-dashed border-border-strong px-3 py-2.5 text-[13px] text-muted">
        <Check size={14} className="mt-0.5 shrink-0 text-lane-4" aria-hidden />
        {usesIndex
          ? "Nothing to suggest: PostgreSQL already uses an index for this query."
          : "Nothing to suggest: no step reads many rows only to keep a few, so an index wouldn't help much here."}
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-3" aria-label="Suggestions">
      {suggestions.map((s, i) => {
        const k = keyOf(s)
        const { problem, fix } = suggestionText(s, plan)
        const running = testing === k && phase !== null
        return (
          <li
            key={k}
            className="perf-in rounded-card border border-[color-mix(in_oklab,var(--lane-6)_35%,var(--border))] bg-[color-mix(in_oklab,var(--lane-6)_4%,var(--surface))]"
            style={{ animationDelay: `${300 + i * 80}ms` }}
          >
            <div className="flex items-start gap-3 px-4 pt-3.5">
              <Lightbulb size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-lane-6" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-[14px] leading-snug text-text">{problem}</p>
                <p className="mt-1 text-[14px] leading-snug text-text">{fix}</p>
                <p className="mt-1.5 text-[12px] text-muted">
                  An index (B-tree) keeps a column's values sorted with pointers to their rows, like the index at the
                  back of a book.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Button
                variant="primary"
                size="sm"
                icon={<Zap size={13} />}
                loading={running}
                disabled={disabled}
                onClick={() => onTest(s)}
              >
                {tested === k ? "Test again" : "Test the speed-up"}
              </Button>
              <details className="group min-w-0 text-[12.5px]">
                <summary className="cursor-pointer select-none text-muted hover:text-text">Show the SQL</summary>
                <CodeBlock code={realDdl(s)} label="to add it to your real tables" className="mt-2" />
              </details>
            </div>
            {running && (
              <div className="px-4 pb-3" aria-live="polite">
                <div className="ex-sweep" aria-hidden />
                <p className="mt-2 text-[12.5px] text-muted">{PHASE_TEXT[phase!](growBy)}</p>
              </div>
            )}
            {error && testing === k && !running && (
              <p role="alert" className="border-t border-border px-4 py-2.5 text-[12.5px] text-danger">
                The speed test failed: {error}
              </p>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function ExplainError({ error, sql }: { error: Error; sql: string }) {
  const code = error instanceof ApiError ? error.code : "network_error"
  const detail = (error instanceof ApiError ? error.detail : null) as QueryErrorDetail | null
  const where = locateError(sql, detail?.position)
  return (
    <div
      role="alert"
      className="perf-in rounded-control border border-[color-mix(in_oklab,var(--danger)_40%,transparent)] px-3.5 py-3"
    >
      <p className="flex items-center gap-2 text-[13.5px] font-medium text-text">
        <AlertTriangle size={14} className="text-danger" aria-hidden />
        {ERROR_TITLE[code] ?? "Couldn't explain this query"}
      </p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{error.message}</p>
      {where && (
        <pre className="scrollbar-thin mt-2 overflow-x-auto font-mono text-[12px] leading-snug text-muted">
          {`line ${where.line} │ ${where.lineText}\n${" ".repeat(`line ${where.line} │ `.length + where.column - 1)}^`}
        </pre>
      )}
      {detail?.sqlstate && <p className="mt-1 font-mono text-[11px] text-faint">SQLSTATE {detail.sqlstate}</p>}
    </div>
  )
}

/** "More": explain again, and reset the test copy (rarely needed, so out of the way). */
function OverflowMenu({
  disabled,
  onExplainAgain,
  onReset,
}: {
  disabled: boolean
  onExplainAgain: () => void
  onReset: () => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false)
    document.addEventListener("mousedown", away)
    document.addEventListener("keydown", esc)
    return () => {
      document.removeEventListener("mousedown", away)
      document.removeEventListener("keydown", esc)
    }
  }, [open])
  const pick = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }
  const item =
    "flex w-full items-start gap-2.5 rounded-[6px] px-2.5 py-2 text-left text-[13px] text-text transition-colors hover:bg-hover disabled:opacity-50"
  return (
    <div ref={root} className="relative">
      <IconButton
        label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="size-7"
      >
        <MoreHorizontal size={16} strokeWidth={1.75} />
      </IconButton>
      {open && (
        <div
          role="menu"
          className="perf-in absolute right-0 top-8 z-20 w-64 rounded-card border border-border-strong bg-raised p-1 shadow-[var(--shadow-pop)]"
        >
          <button type="button" role="menuitem" className={item} disabled={disabled} onClick={pick(onExplainAgain)}>
            <RefreshCw size={14} className="mt-0.5 shrink-0 text-muted" />
            Explain again
          </button>
          <button type="button" role="menuitem" className={item} disabled={disabled} onClick={pick(onReset)}>
            <RotateCcw size={14} className="mt-0.5 shrink-0 text-muted" />
            <span>
              Reset the test copy
              <span className="block text-[11.5px] text-muted">Back to real size, test indexes removed</span>
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
