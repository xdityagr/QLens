import { useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, ChevronLeft, ChevronRight, Clock, Pause, Play, RotateCcw } from "lucide-react"
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react"
import { Button, IconButton } from "../../components/Button"
import { DataGrid } from "../../components/DataGrid"
import { Spinner } from "../../components/Spinner"
import { api, ApiError } from "../../lib/api"
import { fmtInt, fmtMs } from "../../lib/format"
import { laneAlpha, laneVar } from "../../lib/lanes"
import { useReducedMotion } from "../../lib/reveal"
import {
  addedLines,
  barFraction,
  clauseOf,
  isNumericType,
  nextStage,
  operationOf,
  uniqueColumnNames,
  unitOf,
  type StageOut,
} from "../../lib/stepthrough"
import { historyKey } from "./queries"
import "./stepthrough.css"

const AUTOPLAY_MS = 2200

const stepThrough = (wsId: number, sql: string) =>
  api<StageOut[]>(`/api/workspaces/${wsId}/stepthrough`, {
    method: "POST",
    json: { sql },
  })

/**
 * How PostgreSQL evaluates one SELECT, stage by stage: FROM/JOIN, WHERE, GROUP BY, HAVING, SELECT, DISTINCT,
 * ORDER BY/LIMIT. Each stage is a real SELECT the backend runs as the workspace role (POST /stepthrough), so
 * the counts and sample rows are the actual intermediate results.
 *
 * Runs `sql` when mounted. Later edits to `sql` don't re-run on their own (it would run on every keystroke);
 * the panel offers "Step through again" instead.
 */
export function StepThrough({ wsId, sql }: { wsId: number; sql: string }) {
  const [target, setTarget] = useState(sql)
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ["stepthrough", wsId, target],
    queryFn: async () => {
      try {
        return await stepThrough(wsId, target)
      } finally {
        // every request leaves one history row, failed or not
        qc.invalidateQueries({ queryKey: historyKey(wsId) })
      }
    },
    enabled: target.trim() !== "",
    retry: false,
    staleTime: Infinity,
  })
  const changed = sql.trim() !== target.trim()
  const again = () => (changed ? setTarget(sql) : void q.refetch())

  return (
    <section aria-label="Step through" aria-busy={q.isFetching} className="min-w-0">
      {target.trim() === "" ? (
        <p className="rounded-card border border-dashed border-border-strong px-4 py-8 text-center text-[14px] text-muted">
          Write a SELECT first, then step through it.
        </p>
      ) : q.isPending ? (
        <div className="flex min-h-[220px] items-center justify-center gap-3 rounded-card border border-border bg-surface text-[14px] text-muted">
          <Spinner size={16} />
          Running each stage of the query…
        </div>
      ) : q.error ? (
        <StepError error={q.error} onRetry={again} changed={changed} retrying={q.isFetching} />
      ) : (
        <Stages key={q.dataUpdatedAt} stages={q.data} changed={changed} refreshing={q.isFetching} onAgain={again} />
      )}
    </section>
  )
}

function Stages({
  stages,
  changed,
  refreshing,
  onAgain,
}: {
  stages: StageOut[]
  changed: boolean
  refreshing: boolean
  onAgain: () => void
}) {
  const [sel, setSel] = useState(0)
  const [dir, setDir] = useState(1)
  const [playing, setPlaying] = useState(false)
  const stops = useRef<(HTMLButtonElement | null)[]>([])
  const n = stages.length
  const max = Math.max(...stages.map((s) => s.row_count), 0)

  const go = (i: number, focus = false) => {
    const k = Math.max(0, Math.min(n - 1, i))
    setDir(k >= sel ? 1 : -1)
    setSel(k)
    if (focus) stops.current[k]?.focus()
  }
  const manual = (i: number, focus = false) => {
    setPlaying(false)
    go(i, focus)
  }

  // auto-play: one stage every AUTOPLAY_MS, stopping on the last
  useEffect(() => {
    if (!playing) return
    const t = setTimeout(() => {
      const k = nextStage(sel, n)
      if (k === null) setPlaying(false)
      else {
        setDir(1)
        setSel(k)
        if (k === n - 1) setPlaying(false)
      }
    }, AUTOPLAY_MS)
    return () => clearTimeout(t)
  }, [playing, sel, n])

  const togglePlay = () => {
    if (playing) return setPlaying(false)
    if (sel === n - 1) {
      setDir(-1)
      setSel(0)
    }
    setPlaying(true)
  }

  function onKey(e: KeyboardEvent, i: number) {
    const k =
      e.key === "ArrowRight"
        ? i + 1
        : e.key === "ArrowLeft"
          ? i - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : null
    if (k === null) return
    e.preventDefault()
    manual(k, true)
  }

  const stage = stages[sel]
  const prev = sel > 0 ? stages[sel - 1] : null

  return (
    <div className={`transition-opacity duration-200 ${refreshing ? "opacity-60" : ""}`}>
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="mr-auto max-w-[60ch] text-[13px] leading-relaxed text-muted">
          Each stage below is a real query run on your tables, so the counts are what PostgreSQL actually had at that
          point.
        </p>
        {changed && (
          <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={onAgain} loading={refreshing}>
            Step through the edited query
          </Button>
        )}
        <div className="flex items-center gap-1">
          <IconButton
            label="Previous stage"
            onClick={() => manual(sel - 1)}
            disabled={sel === 0}
            className="disabled:opacity-40"
          >
            <ChevronLeft size={16} />
          </IconButton>
          <Button
            size="sm"
            variant={playing ? "secondary" : "primary"}
            icon={playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
            onClick={togglePlay}
            aria-pressed={playing}
            className="relative overflow-hidden"
          >
            {playing ? "Pause" : sel === n - 1 ? "Replay" : "Play"}
            {playing && (
              <span
                key={sel}
                aria-hidden
                className="st-timer"
                style={{ "--st-interval": `${AUTOPLAY_MS}ms` } as CSSProperties}
              />
            )}
          </Button>
          <IconButton
            label="Next stage"
            onClick={() => manual(sel + 1)}
            disabled={sel === n - 1}
            className="disabled:opacity-40"
          >
            <ChevronRight size={16} />
          </IconButton>
        </div>
      </div>

      {/* the rail: one stop per stage on a lane, the lane filled up to the selected stage */}
      <div className="scrollbar-thin -mx-1 overflow-x-auto px-1 pb-1">
        <div
          role="tablist"
          aria-label="Stages of the query"
          className="st-rail min-w-[520px] pt-1"
          style={
            {
              "--st-n": n,
              "--st-top": "30px",
              "--st-progress": n > 1 ? sel / (n - 1) : 0,
            } as CSSProperties
          }
        >
          <span aria-hidden className="st-lane st-lane-draw" />
          <span aria-hidden className="st-lane-fill" />
          {stages.map((s, i) => (
            <button
              key={s.kind}
              ref={(el) => {
                stops.current[i] = el
              }}
              type="button"
              role="tab"
              id={`st-tab-${i}`}
              aria-selected={i === sel}
              aria-controls="st-panel"
              tabIndex={i === sel ? 0 : -1}
              data-passed={i <= sel}
              onClick={() => manual(i)}
              onKeyDown={(e) => onKey(e, i)}
              className="st-stop st-enter"
              style={{ animationDelay: `${i * 70}ms` }}
              aria-label={`${s.title}: ${fmtInt(s.row_count)} ${unitOf(s.kind, s.row_count)}`}
            >
              <span aria-hidden className="h-[18px] font-mono text-[13px] leading-[18px]">
                {s.symbol}
              </span>
              <span aria-hidden className="st-dot" />
              <span className="mt-0.5 whitespace-nowrap font-mono text-[11.5px] font-medium">{clauseOf(s.title)}</span>
              <span className="num font-mono text-[12.5px] tabular-nums">{fmtInt(s.row_count)}</span>
              <span aria-hidden className="st-bar">
                <span
                  style={
                    {
                      "--st-bar": barFraction(s.row_count, max),
                    } as CSSProperties
                  }
                />
              </span>
            </button>
          ))}
        </div>
      </div>

      <div
        id="st-panel"
        role="tabpanel"
        aria-labelledby={`st-tab-${sel}`}
        key={sel}
        className="st-detail mt-5"
        style={{ "--st-dir": dir } as CSSProperties}
      >
        <StageDetail stage={stage} prev={prev} index={sel} total={n} />
      </div>
    </div>
  )
}

function StageDetail({
  stage,
  prev,
  index,
  total,
}: {
  stage: StageOut
  prev: StageOut | null
  index: number
  total: number
}) {
  const shown = useTween(prev?.row_count ?? 0, stage.row_count)
  const names = uniqueColumnNames(stage.columns.map((c) => c.name))
  const columns = stage.columns.map((c, i) => ({
    name: names[i],
    type: c.type,
    numeric: isNumericType(c.type),
  }))
  const unit = unitOf(stage.kind, stage.row_count)
  return (
    <div>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div className="mr-auto min-w-0">
          <p className="text-[12px] text-faint">
            Stage {index + 1} of {total}
          </p>
          <h3 className="mt-0.5 flex items-baseline gap-2 text-[18px] font-medium text-text">
            <span aria-hidden className="font-mono text-accent">
              {stage.symbol}
            </span>
            {operationOf(stage.title)}
            <span className="font-mono text-[13px] font-normal text-muted">{clauseOf(stage.title)}</span>
          </h3>
        </div>
        <p className="font-mono text-[15px] tabular-nums" aria-live="polite">
          {prev && (
            <>
              <span className="text-muted">{fmtInt(prev.row_count)}</span>
              <span aria-hidden className="mx-2 text-faint">
                →
              </span>
              <span className="sr-only"> to </span>
            </>
          )}
          <span className="font-medium text-text">{fmtInt(shown)}</span>
          <span className="ml-1.5 font-sans text-[13px] text-muted">{unit}</span>
        </p>
      </div>
      <p className="mt-2 max-w-[80ch] break-words text-[14px] leading-relaxed text-text">{stage.caption}</p>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="min-w-0">
          <StageSql sql={stage.sql} prev={prev?.sql ?? null} durationMs={stage.duration_ms} />
        </div>
        <div className="min-w-0">
          {stage.columns.length > 0 ? (
            <DataGrid columns={columns} rows={stage.rows} maxHeight={360} />
          ) : (
            <p className="rounded-card border border-border bg-surface px-4 py-6 text-center text-[13px] text-muted">
              This stage returns no columns.
            </p>
          )}
          {stage.row_count > stage.rows.length && (
            <p className="mt-2 text-[12px] text-faint">
              First {fmtInt(stage.rows.length)} of {fmtInt(stage.row_count)} {unit}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

/** The stage's own SELECT, with the lines it adds to the previous stage marked. */
function StageSql({ sql, prev, durationMs }: { sql: string; prev: string | null; durationMs: number }) {
  const added = addedLines(prev, sql)
  return (
    <figure className="rounded-card border border-border bg-surface">
      <figcaption className="flex h-9 items-center justify-between gap-3 border-b border-border px-3.5 text-[12px] text-muted">
        <span>{prev === null ? "SQL of this stage" : "SQL of this stage, new lines marked"}</span>
        <span className="font-mono tabular-nums text-faint">{fmtMs(durationMs)}</span>
      </figcaption>
      <pre className="scrollbar-thin max-h-[320px] overflow-auto py-2.5 font-mono text-[12.5px] leading-[1.7] text-text">
        <code>
          {sql.split("\n").map((line, i) => (
            <span
              key={i}
              className="block whitespace-pre border-l-2 pl-3 pr-3.5"
              style={
                added[i]
                  ? {
                      borderColor: "var(--accent)",
                      background: laneAlpha(0, 0.1),
                    }
                  : { borderColor: "transparent" }
              }
            >
              {line}
              {added[i] && <span className="sr-only"> (added by this stage)</span>}
            </span>
          ))}
        </code>
      </pre>
    </figure>
  )
}

/** Eases a count from `from` to `to` (the previous stage's count to this one's). Reduced motion jumps. */
function useTween(from: number, to: number, duration = 520): number {
  const reduced = useReducedMotion()
  const [value, setValue] = useState(from)
  const still = reduced || from === to
  useEffect(() => {
    if (still) return
    let raf = 0
    const start = performance.now()
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration)
      setValue(from + (to - from) * (1 - Math.pow(1 - p, 3)))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [from, to, duration, still])
  return still ? to : value
}

function StepError({
  error,
  onRetry,
  changed,
  retrying,
}: {
  error: Error
  onRetry: () => void
  changed: boolean
  retrying: boolean
}) {
  const code = error instanceof ApiError ? error.code : "network_error"
  const title =
    code === "stepthrough_unsupported"
      ? "This query can't be shown stage by stage"
      : code === "timeout"
        ? "A stage ran past the 5-second limit"
        : code === "db_error"
          ? "PostgreSQL couldn't run a stage"
          : code === "network_error"
            ? "Couldn't reach the server"
            : "Couldn't step through this query"
  const tone = code === "timeout" ? 3 : 7
  return (
    <div role="alert" className="rounded-card border bg-surface p-4" style={{ borderColor: laneAlpha(tone, 0.4) }}>
      <div className="flex items-start gap-3">
        <span
          className="grid size-8 shrink-0 place-items-center rounded-full"
          style={{ color: laneVar(tone), background: laneAlpha(tone, 0.12) }}
        >
          {code === "timeout" ? <Clock size={16} /> : <AlertTriangle size={16} />}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-medium text-text">{title}</h3>
          <p className="mt-1 break-words text-[13.5px] leading-relaxed text-text">{error.message}</p>
          {/* re-running an unsupported query would only fail again; offer it once the SQL has changed */}
          {(changed || code !== "stepthrough_unsupported") && (
            <Button size="sm" className="mt-3" icon={<RotateCcw size={13} />} onClick={onRetry} loading={retrying}>
              {changed ? "Step through the edited query" : "Try again"}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
