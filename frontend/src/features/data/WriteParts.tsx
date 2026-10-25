import { AlertTriangle, CheckCircle2, Play, Table2 } from "lucide-react"
import { useEffect, useRef } from "react"
import { Link } from "react-router"
import { Button } from "../../components/Button"
import { DataGrid } from "../../components/DataGrid"
import { fmtInt, fmtMs } from "../../lib/format"
import { laneAlpha, laneVar } from "../../lib/lanes"
import { useCountUp } from "../../lib/reveal"
import type { StatementInfo } from "../../lib/sqlKind"
import type { SqlWriteOut } from "./api"

const VERB_TONE: Record<string, string> = { insert: "var(--lane-4)", update: "var(--lane-1)", delete: "var(--danger)" }
const PREP: Record<string, string> = { insert: "into", update: "in", delete: "from" }

/**
 * Asked before any INSERT, UPDATE or DELETE runs: what it will change, and what happens if a row breaks a rule.
 * Enter or the button runs it; Esc or Cancel goes back to the editor.
 */
export function ConfirmWrite({
  info,
  lane,
  running,
  onRun,
  onCancel,
}: {
  info: StatementInfo
  lane: number | null
  running: boolean
  onRun: () => void
  onCancel: () => void
}) {
  const runRef = useRef<HTMLButtonElement>(null)
  useEffect(() => runRef.current?.focus(), [])
  const verb = info.keyword ?? info.kind.toUpperCase()
  const everyRow = (info.kind === "update" || info.kind === "delete") && !info.hasWhere
  return (
    <div
      role="alertdialog"
      aria-labelledby="write-confirm-title"
      aria-describedby="write-confirm-desc"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault()
          onCancel()
        }
      }}
      className="dw-confirm relative overflow-hidden rounded-card border bg-raised py-4 pl-5 pr-4"
      style={{ borderColor: `color-mix(in oklab, ${VERB_TONE[info.kind]} 40%, var(--border-strong))` }}
    >
      <span
        aria-hidden
        className="dw-stripe absolute inset-y-0 left-0 w-[3px]"
        style={{ background: VERB_TONE[info.kind] }}
      />
      <div className="flex flex-wrap items-start gap-x-5 gap-y-3">
        <div className="min-w-0 flex-1">
          <p id="write-confirm-title" className="text-[16px] leading-snug text-text">
            This will{" "}
            <span className="font-mono text-[14.5px] font-semibold" style={{ color: VERB_TONE[info.kind] }}>
              {verb}
            </span>{" "}
            rows {PREP[info.kind]}{" "}
            <span className="inline-flex items-center gap-1.5 font-mono text-[14.5px]">
              {lane !== null && (
                <span aria-hidden className="size-2 rounded-full" style={{ background: laneVar(lane) }} />
              )}
              {info.table ?? "a table"}
            </span>
            . Run it?
          </p>
          <div id="write-confirm-desc" className="mt-1.5 flex flex-col gap-1 text-[13px] leading-relaxed text-muted">
            {everyRow && (
              <p className="flex items-start gap-1.5 text-text">
                <AlertTriangle size={14} className="mt-[3px] shrink-0 text-lane-3" aria-hidden />
                There is no WHERE clause, so every row of {info.table ?? "the table"} changes.
              </p>
            )}
            <p>
              It runs in one transaction: if any row breaks a constraint, nothing changes. A trigger records every row
              it does change.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 self-center">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            ref={runRef}
            variant={info.kind === "delete" ? "danger" : "primary"}
            size="sm"
            loading={running}
            onClick={onRun}
            icon={<Play size={13} fill="currentColor" />}
          >
            Run {verb}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** A committed write: how many rows it changed, what RETURNING gave, and where to see the change. */
export function WriteResult({ out, lane }: { out: SqlWriteOut; lane: number | null }) {
  const shown = useCountUp(out.row_count, true, 520)
  const tone = lane ?? 4
  const noun = out.row_count === 1 ? "row" : "rows"
  return (
    <div className="q-result flex flex-col gap-3" role="status">
      <div
        className="relative overflow-hidden rounded-card border bg-surface px-4 py-3.5"
        style={{ borderColor: laneAlpha(tone, 0.35) }}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <CheckCircle2
            size={18}
            strokeWidth={1.75}
            className="shrink-0"
            style={{ color: laneVar(tone) }}
            aria-hidden
          />
          <p className="text-[15px] text-text">
            <span className="num text-[22px] font-medium tracking-[-0.02em]">{fmtInt(shown)}</span> {noun}{" "}
            {out.statement === "INSERT" ? "inserted into" : out.statement === "UPDATE" ? "updated in" : "deleted from"}{" "}
            <span className="font-mono text-[13.5px]" style={{ color: laneVar(tone) }}>
              {out.table}
            </span>
            <span className="text-muted"> in </span>
            <span className="num">{fmtMs(out.duration_ms)}</span>
          </p>
          <Link
            to={`?table=${encodeURIComponent(out.table)}`}
            className="ml-auto inline-flex items-center gap-1.5 text-[13px] text-muted underline-offset-4 hover:text-text hover:underline"
          >
            <Table2 size={14} aria-hidden />
            See it in Browse
          </Link>
        </div>
        <p className="mt-1.5 text-[12.5px] text-muted">
          {out.row_count === 0
            ? "Nothing matched, so nothing changed."
            : "Committed. The audit trigger logged each changed row; Browse lists them under Recent changes."}
        </p>
      </div>
      {out.returning && (
        <div>
          <p className="mb-2 px-0.5 text-[13px] text-muted">
            RETURNING gave{" "}
            {out.returning.truncated ? `the first ${out.returning.rows.length}` : fmtInt(out.returning.rows.length)}{" "}
            {out.returning.rows.length === 1 ? "row" : "rows"}
          </p>
          <DataGrid
            columns={out.returning.columns.map((c) => ({ name: c.name, type: c.type }))}
            rows={out.returning.rows}
            maxHeight="min(360px, 50vh)"
          />
        </div>
      )}
    </div>
  )
}
