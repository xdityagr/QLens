import { useState } from "react"
import { Spinner } from "../../components/Spinner"
import { fmtRelative } from "../../lib/format"
import { laneAlpha, laneVar } from "../../lib/lanes"
import { diffRow, type DiffEntry } from "../../lib/rowValues"
import type { ChangeOp, ChangeOut, ChangesOut } from "./api"

const OP: Record<ChangeOp, { lane: number }> = {
  INSERT: { lane: 4 },
  UPDATE: { lane: 0 },
  DELETE: { lane: 7 },
}
// An INSERT or DELETE lists the row's values; this many, then "+n more".
const MAX_VALUES = 4

const absTime = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })

function Value({ v, struck }: { v: unknown; struck?: boolean }) {
  if (v === null || v === undefined) return <span className="text-faint">NULL</span>
  return (
    <span
      className={
        struck ? "text-muted line-through decoration-[color-mix(in_oklab,var(--danger)_60%,transparent)]" : "text-text"
      }
    >
      {String(v)}
    </span>
  )
}

function Diff({ c, order }: { c: ChangeOut; order: string[] }) {
  // JSON keeps keys in its own order; show them in the table's column order
  const rank = (col: string) => (order.indexOf(col) + order.length + 1) % (order.length + 1)
  const all = diffRow(c.before, c.after).sort((a, b) => rank(a.column) - rank(b.column))
  const entries: DiffEntry[] = c.op === "UPDATE" ? all.filter((d) => d.changed) : all
  const shown = c.op === "UPDATE" ? entries : entries.slice(0, MAX_VALUES)
  if (entries.length === 0) return <p className="mt-1.5 text-[12px] text-muted">Saved with the same values.</p>
  return (
    <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-[11.5px] leading-relaxed">
      {shown.map((d) => (
        <div key={d.column} className="contents">
          <dt className="text-faint">{d.column}</dt>
          <dd className="min-w-0 break-words">
            {c.op === "UPDATE" ? (
              <>
                <Value v={d.before} struck /> <span className="text-faint">→</span> <Value v={d.after} />
              </>
            ) : c.op === "DELETE" ? (
              <Value v={d.before} struck />
            ) : (
              <Value v={d.after} />
            )}
          </dd>
        </div>
      ))}
      {entries.length > shown.length && (
        <dd className="col-span-2 text-faint">+{entries.length - shown.length} more</dd>
      )}
    </dl>
  )
}

/**
 * The audit log, newest first. Every entry was written by the AFTER ... FOR EACH ROW trigger on the table,
 * so it records changes made from anywhere, not only from this screen.
 */
export function ChangeTimeline({
  data,
  pending,
  laneOf,
  columnsOf,
}: {
  data: ChangesOut | undefined
  pending: boolean
  laneOf: (table: string) => number
  columnsOf: (table: string) => string[]
}) {
  // Entries already there on first load just appear; later ones animate in.
  const [seen, setSeen] = useState<number | null>(null)
  if (data && seen === null) setSeen(data.changes[0]?.id ?? 0)
  const firstSeen = seen ?? Infinity

  return (
    <section aria-labelledby="changes-h" className="rounded-card border border-border bg-surface">
      <header className="border-b border-border px-4 py-3.5">
        <h3 id="changes-h" className="text-[15px] font-medium tracking-[-0.01em] text-text">
          Recent changes
        </h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
          Recorded by the database, not the app: each table has an{" "}
          <code className="font-mono text-[11.5px] text-text">AFTER INSERT OR UPDATE OR DELETE</code> trigger that runs{" "}
          <code className="font-mono text-[11.5px] text-text">qlens.log_row_change()</code>.
        </p>
      </header>

      {pending ? (
        <div className="grid place-items-center py-10 text-muted">
          <Spinner size={16} />
        </div>
      ) : !data || data.changes.length === 0 ? (
        <p className="px-4 py-8 text-center text-[13px] leading-relaxed text-muted">
          No edits since the design was applied. Add, change or delete a row and the trigger's entry shows up here.
        </p>
      ) : (
        <ol className="scrollbar-thin relative max-h-[640px] overflow-y-auto px-4 py-3">
          {data.changes.map((c, i) => {
            const op = OP[c.op]
            const fresh = c.id > firstSeen
            return (
              <li key={c.id} className={`relative pb-4 pl-6 ${fresh ? "dc-log-in" : ""}`}>
                {/* the lane: a line through every entry, a node per change in its operation's colour */}
                {i < data.changes.length - 1 && (
                  <span aria-hidden className="absolute bottom-0 left-[5px] top-[14px] w-px bg-border-strong" />
                )}
                <span aria-hidden className="absolute left-0 top-[5px] grid size-[11px] place-items-center">
                  {fresh && (
                    <span
                      className="dc-node-ping absolute inset-0 rounded-full"
                      style={{ background: laneVar(op.lane) }}
                    />
                  )}
                  <span
                    className="relative size-[9px] rounded-full border-2 bg-bg"
                    style={{ borderColor: laneVar(op.lane) }}
                  />
                </span>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    className="inline-flex h-[20px] items-center rounded-full border px-1.5 font-mono text-[10.5px] font-semibold tracking-[0.03em]"
                    style={{
                      borderColor: laneAlpha(op.lane, 0.35),
                      background: laneAlpha(op.lane, 0.1),
                      color: laneVar(op.lane),
                    }}
                  >
                    {c.op}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 font-mono text-[12.5px] text-text">
                    <span
                      aria-hidden
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ background: laneVar(laneOf(c.table_name)) }}
                    />
                    <span className="truncate">{c.table_name}</span>
                    {c.row_pk !== null && <span className="text-muted">#{c.row_pk}</span>}
                  </span>
                  <time
                    dateTime={c.changed_at}
                    title={absTime(c.changed_at)}
                    className="ml-auto text-[11.5px] text-faint"
                  >
                    {fmtRelative(c.changed_at)}
                  </time>
                </div>
                <Diff c={c} order={columnsOf(c.table_name)} />
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
