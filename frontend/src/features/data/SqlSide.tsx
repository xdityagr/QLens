import { FilePlus2, Pencil, Trash2 } from "lucide-react"
import { useState } from "react"
import { IconButton } from "../../components/Button"
import { Sparkline } from "../../components/Sparkline"
import { fmtMs, fmtRelative } from "../../lib/format"
import type { QueryableTable, RunOut, SavedQueryOut } from "../query/api"
import { useHistory, useTrend } from "../query/queries"
import { SchemaSidebar } from "../query/SchemaSidebar"

type Pane = "tables" | "saved" | "recent"

const RECENT = 12

/**
 * The SQL tab's side column: the tables to click into the editor, saved queries, and the latest runs. One pane
 * at a time, so it stays a compact column beside the editor.
 */
export function SqlSide({
  wsId,
  tables,
  sourceTables,
  showSource,
  onShowSource,
  laneOf,
  onInsert,
  saved,
  activeId,
  dirty,
  onPick,
  onNew,
  onRename,
  onDelete,
  onOpenSql,
}: {
  wsId: number
  tables: QueryableTable[]
  sourceTables: QueryableTable[]
  showSource: boolean
  onShowSource: (v: boolean) => void
  laneOf: (t: string) => number | null
  onInsert: (text: string) => void
  saved: SavedQueryOut[]
  activeId: number | null
  dirty: boolean
  onPick: (q: SavedQueryOut) => void
  onNew: () => void
  onRename: (q: SavedQueryOut) => void
  onDelete: (q: SavedQueryOut) => void
  onOpenSql: (sql: string) => void
}) {
  const [pane, setPane] = useState<Pane>("tables")
  const history = useHistory(wsId, pane === "recent")
  const panes: { key: Pane; label: string; count?: number }[] = [
    { key: "tables", label: "Tables" },
    { key: "saved", label: "Saved", count: saved.length },
    { key: "recent", label: "Recent" },
  ]
  return (
    <div className="flex min-h-0 flex-col">
      <div
        role="tablist"
        aria-label="Side panel"
        className="mb-3 grid grid-cols-3 rounded-control border border-border p-0.5"
      >
        {panes.map((p) => (
          <button
            key={p.key}
            type="button"
            role="tab"
            aria-selected={pane === p.key}
            onClick={() => setPane(p.key)}
            className={
              "flex h-7 items-center justify-center gap-1.5 rounded-[6px] text-[12.5px] transition-[background-color,color] duration-150 " +
              (pane === p.key
                ? "bg-raised text-text shadow-[inset_0_0_0_1px_var(--border-strong)]"
                : "text-muted hover:text-text")
            }
          >
            {p.label}
            {p.count ? <span className="num text-[11px] text-faint">{p.count}</span> : null}
          </button>
        ))}
      </div>

      <div role="tabpanel" aria-label={panes.find((p) => p.key === pane)!.label} className="min-h-0">
        {pane === "tables" && (
          <SchemaSidebar
            tables={tables}
            sourceTables={sourceTables}
            showSource={showSource}
            onShowSource={onShowSource}
            onInsert={onInsert}
            laneOf={laneOf}
          />
        )}
        {pane === "saved" && (
          <ul className="flex flex-col gap-0.5">
            <li>
              <button
                type="button"
                onClick={onNew}
                className={rowClass(activeId === null)}
                aria-current={activeId === null ? "true" : undefined}
              >
                <span className="flex items-center gap-1.5 text-[13px]">
                  <FilePlus2 size={13} className="text-muted" aria-hidden />
                  {activeId === null ? "Unsaved query" : "New query"}
                </span>
                <span className="text-[11.5px] text-faint">
                  {activeId === null && dirty ? "Not saved yet" : "Start from an empty editor"}
                </span>
              </button>
            </li>
            {saved.map((q) => (
              <SavedRow
                key={q.id}
                wsId={wsId}
                q={q}
                active={q.id === activeId}
                dirty={dirty && q.id === activeId}
                onPick={onPick}
                onRename={onRename}
                onDelete={onDelete}
              />
            ))}
            {saved.length === 0 && (
              <li className="px-2 py-3 text-[12.5px] leading-relaxed text-muted">
                Save a query to keep it here with its run count and timing.
              </li>
            )}
          </ul>
        )}
        {pane === "recent" && (
          <ul className="flex flex-col gap-0.5">
            {(history.data ?? []).slice(0, RECENT).map((r) => (
              <RecentRow key={r.id} run={r} onOpen={onOpenSql} />
            ))}
            {history.data?.length === 0 && (
              <li className="px-2 py-3 text-[12.5px] leading-relaxed text-muted">
                Runs show up here once you run SQL.
              </li>
            )}
            {history.isPending && <li className="px-2 py-3 text-[12.5px] text-faint">Loading runs…</li>}
          </ul>
        )}
      </div>
    </div>
  )
}

function rowClass(active: boolean) {
  return (
    "relative flex w-full min-w-0 flex-col items-start gap-0.5 rounded-control px-2.5 py-2 text-left transition-[background-color,color] duration-150 " +
    (active
      ? "bg-raised text-text shadow-[inset_0_0_0_1px_var(--border)]"
      : "text-muted hover:bg-hover hover:text-text")
  )
}

function SavedRow({
  wsId,
  q,
  active,
  dirty,
  onPick,
  onRename,
  onDelete,
}: {
  wsId: number
  q: SavedQueryOut
  active: boolean
  dirty: boolean
  onPick: (q: SavedQueryOut) => void
  onRename: (q: SavedQueryOut) => void
  onDelete: (q: SavedQueryOut) => void
}) {
  const { data: trend } = useTrend(wsId, q.id, q.run_count)
  const values = (trend ?? []).slice(-20).map((p) => p.duration_ms)
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => onPick(q)}
        aria-current={active ? "true" : undefined}
        className={rowClass(active) + " pr-16"}
        title={q.sql_text}
      >
        {active && <span aria-hidden className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-accent" />}
        <span className="flex w-full min-w-0 items-center gap-1.5 text-[13px]">
          <span className="min-w-0 truncate">{q.title}</span>
          {dirty && (
            <span
              aria-label="edited"
              title="Edited since it was saved"
              className="size-1.5 shrink-0 rounded-full bg-lane-3"
            />
          )}
        </span>
        <span className="flex w-full items-center gap-2 text-[11.5px] text-faint">
          <span className="num">
            {q.run_count} {q.run_count === 1 ? "run" : "runs"}
          </span>
          {q.last_duration_ms !== null && <span className="num">{fmtMs(q.last_duration_ms)}</span>}
          {values.length > 1 && (
            <Sparkline values={values} width={40} height={12} color={active ? "var(--accent)" : "var(--muted)"} />
          )}
        </span>
      </button>
      <span className="absolute right-1 top-1.5 flex opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
        <IconButton label={`Rename ${q.title}`} onClick={() => onRename(q)} className="size-7">
          <Pencil size={12} />
        </IconButton>
        <IconButton label={`Delete ${q.title}`} onClick={() => onDelete(q)} className="size-7">
          <Trash2 size={12} />
        </IconButton>
      </span>
    </li>
  )
}

const STATUS_TONE: Record<RunOut["status"], string> = {
  ok: "var(--lane-4)",
  error: "var(--danger)",
  timeout: "var(--lane-3)",
}

function RecentRow({ run, onOpen }: { run: RunOut; onOpen: (sql: string) => void }) {
  const oneLine = run.sql_text.replace(/\s+/g, " ").trim()
  return (
    <li>
      <button type="button" onClick={() => onOpen(run.sql_text)} className={rowClass(false)} title={run.sql_text}>
        <span className="flex w-full min-w-0 items-center gap-2">
          <span
            aria-label={run.status === "ok" ? "Ran" : run.status === "timeout" ? "Timed out" : "Failed"}
            className="size-1.5 shrink-0 rounded-full"
            style={{ background: STATUS_TONE[run.status] }}
          />
          <span className="min-w-0 truncate font-mono text-[12px] text-text">{oneLine}</span>
        </span>
        <span className="flex w-full items-center gap-2 pl-3.5 text-[11.5px] text-faint">
          <span>{fmtRelative(run.created_at)}</span>
          {run.row_count !== null && (
            <span className="num">
              {run.row_count} {run.row_count === 1 ? "row" : "rows"}
            </span>
          )}
          {run.duration_ms !== null && <span className="num">{fmtMs(run.duration_ms)}</span>}
        </span>
      </button>
    </li>
  )
}
