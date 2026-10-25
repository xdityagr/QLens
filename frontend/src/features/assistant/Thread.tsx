import { BookOpen, Check, CircleAlert, Copy, Database, PencilLine, RotateCw, SearchCheck } from "lucide-react"
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { Button, IconButton } from "../../components/Button"
import { DataGrid } from "../../components/DataGrid"
import { fmtInt } from "../../lib/format"
import { useReducedMotion } from "../../lib/reveal"
import type { SqlRun } from "./api"
import { typewriterCuts, type Chip, type ChipTone, type Turn } from "./logic"
import { Markdown, type LaneOf } from "./Markdown"

/** What a SQL block offers besides Copy: "Open in Query" on Design, "Insert into editor" on Query. */
export interface SqlAction {
  label: string
  icon: ReactNode
  run: (sql: string) => void
}

/**
 * Paces a finished reply onto the screen word by word (the API doesn't stream). Reduced motion, or a
 * turn that isn't fresh, shows the whole text at once.
 */
function useTypewriter(text: string, active: boolean, onDone: () => void): string {
  const reduced = useReducedMotion()
  const run = active && !reduced
  const [shown, setShown] = useState(run ? 0 : text.length)
  const done = useRef(onDone)
  useEffect(() => {
    done.current = onDone
  })
  useEffect(() => {
    if (!run) {
      if (active) done.current()
      return
    }
    const cuts = typewriterCuts(text, 90)
    const total = Math.min(1800, Math.max(420, text.length * 8))
    const start = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const k = Math.min(cuts.length - 1, Math.floor(((now - start) / total) * cuts.length))
      setShown(cuts[k])
      if (k < cuts.length - 1) raf = requestAnimationFrame(tick)
      else done.current()
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [text, run, active])
  return run ? text.slice(0, shown) : text
}

export function UserTurn({ turn }: { turn: Turn }) {
  return (
    <div className="as-turn border-l-2 border-[color-mix(in_oklab,var(--accent)_70%,transparent)] pl-3 text-[14px] font-medium leading-snug text-text">
      {turn.text}
    </div>
  )
}

export function AssistantTurn({
  turn,
  laneOf,
  sqlAction,
  onSettle,
  onRetry,
}: {
  turn: Turn
  laneOf: LaneOf
  sqlAction: SqlAction | null
  onSettle: (key: string) => void
  onRetry: (() => void) | null
}) {
  const text = useTypewriter(turn.text, turn.fresh, () => onSettle(turn.key))
  if (turn.error)
    return (
      <div
        role="alert"
        className="as-turn rounded-card border border-[color-mix(in_oklab,var(--danger)_35%,transparent)] bg-[color-mix(in_oklab,var(--danger)_6%,transparent)] px-3.5 py-3"
      >
        <p className="flex items-center gap-2 text-[13.5px] font-medium text-danger">
          <CircleAlert size={15} strokeWidth={2} />
          {turn.error.title}
        </p>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">{turn.error.message}</p>
        {onRetry && turn.error.kind !== "off" && (
          <Button size="sm" variant="secondary" className="mt-2.5" icon={<RotateCw size={13} />} onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    )

  const failed = turn.chips.filter((c) => c.tone === "fail" && c.detail)
  return (
    <div className="as-turn flex flex-col gap-3">
      <Markdown
        text={text}
        laneOf={laneOf}
        renderSql={(sql, key) => <SqlEvidence key={key} sql={sql} run={null} action={sqlAction} />}
      />
      {/* the evidence arrives once the text has finished */}
      {!turn.fresh && turn.chips.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <ul aria-label="What the assistant did" className="flex flex-wrap gap-1.5">
            {turn.chips.map((c, i) => (
              <ToolChip key={i} chip={c} index={i} />
            ))}
          </ul>
          {failed.map((c, i) => (
            <p key={i} className="text-[12px] leading-relaxed text-muted">
              <span className="text-danger">{c.label}:</span> {c.detail}
            </p>
          ))}
        </div>
      )}
      {!turn.fresh &&
        turn.sqlRuns.map((r, i) => (
          <div key={i} className="as-chip" style={{ "--i": turn.chips.length + i } as CSSProperties}>
            <SqlEvidence sql={r.sql} run={r} action={sqlAction} />
          </div>
        ))}
      {/* screen readers get the finished reply once, not every word of the typewriter */}
      {!turn.fresh && (
        <span className="sr-only" aria-live="polite">
          {turn.intent === "edit" ? "Design changed. " : ""}
          {turn.text}
        </span>
      )}
    </div>
  )
}

const TONE: Record<ChipTone, { icon: ReactNode; color: string }> = {
  read: { icon: <BookOpen size={12} strokeWidth={2} />, color: "var(--muted)" },
  check: { icon: <SearchCheck size={12} strokeWidth={2} />, color: "var(--lane-5)" },
  sql: { icon: <Database size={12} strokeWidth={2} />, color: "var(--lane-1)" },
  edit: { icon: <PencilLine size={12} strokeWidth={2} />, color: "var(--lane-4)" },
  fail: { icon: <CircleAlert size={12} strokeWidth={2} />, color: "var(--danger)" },
}

export function ToolChip({ chip, index }: { chip: Chip; index: number }) {
  const t = TONE[chip.tone]
  return (
    <li
      className="as-chip inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 text-[12px] text-text"
      style={{ "--i": index } as CSSProperties}
      title={chip.detail}
    >
      <span className="shrink-0" style={{ color: t.color }}>
        {t.icon}
      </span>
      <span className="truncate">{chip.label}</span>
    </li>
  )
}

const NUMERIC = /int|numeric|decimal|real|double|float|money/i

/** SQL the assistant wrote (and maybe ran), with copy, the screen's action, and the rows it got back. */
export function SqlEvidence({ sql, run, action }: { sql: string; run: SqlRun | null; action: SqlAction | null }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(t)
  }, [copied])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sql)
      setCopied(true)
    } catch {
      // clipboard blocked (insecure context); nothing sensible to do
    }
  }
  const shownRows = run ? run.rows.length : 0
  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface">
      <div className="flex h-9 items-center gap-2 border-b border-border pl-3 pr-1">
        <Database size={13} strokeWidth={2} className="shrink-0 text-lane-1" />
        <span className="truncate text-[12px] text-muted">
          {run
            ? `Ran this, ${fmtInt(run.row_count)} ${run.row_count === 1 ? "row" : "rows"}${
                shownRows < run.row_count ? `, first ${shownRows} shown` : ""
              }`
            : "SQL"}
        </span>
        <span className="ml-auto flex shrink-0 items-center">
          {action && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[12px]"
              icon={action.icon}
              onClick={() => action.run(sql)}
            >
              {action.label}
            </Button>
          )}
          <IconButton label={copied ? "Copied" : "Copy SQL"} onClick={copy} className="size-7">
            {copied ? <Check size={14} className="text-lane-4" /> : <Copy size={13} strokeWidth={1.75} />}
          </IconButton>
        </span>
      </div>
      <pre className="scrollbar-thin max-h-[180px] overflow-auto px-3 py-2.5 font-mono text-[12px] leading-[1.6] text-text">
        <code>{sql}</code>
      </pre>
      {run && run.columns.length > 0 && (
        <DataGrid
          columns={run.columns.map((c) => ({
            name: c.name,
            type: c.type,
            numeric: c.type ? NUMERIC.test(c.type) : false,
          }))}
          rows={run.rows}
          maxHeight={220}
          className="rounded-none border-x-0 border-b-0"
        />
      )}
    </div>
  )
}

/** While the reply is on its way: honest about not knowing which tools are running yet. */
export function ThinkingTurn() {
  return (
    <div className="as-turn flex flex-col gap-2" aria-label="The assistant is working">
      <p className="as-pending-text text-[13px] text-muted">Working on it</p>
      <span className="as-skeleton h-2.5 w-[88%]" />
      <span className="as-skeleton h-2.5 w-[72%]" style={{ animationDelay: "160ms" }} />
      <span className="as-skeleton h-2.5 w-[54%]" style={{ animationDelay: "320ms" }} />
    </div>
  )
}
