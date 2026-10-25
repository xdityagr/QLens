import { ArrowRight, Pencil, Trash2, X } from "lucide-react"
import { useState } from "react"
import { Button, IconButton } from "../../components/Button"
import { Spinner } from "../../components/Spinner"
import { fmtInt } from "../../lib/format"
import { laneVar } from "../../lib/lanes"
import type { RowFilter } from "../../lib/rowFilters"
import type { Cell } from "../../lib/types"
import type { DataColumn, RelatedOut, Row } from "./api"
import { ConstraintCard } from "./ConstraintCard"
import { useRelated, useWriteRow } from "./queries"

// In a related row's one-line summary: the id plus this many other values.
const SUMMARY_VALUES = 3

function Plain({ v }: { v: Cell }) {
  if (v === null || v === undefined) return <span className="text-faint">NULL</span>
  return <>{String(v)}</>
}

function FkLink({
  table,
  id,
  label,
  lane,
  onJump,
}: {
  table: string
  id: Cell
  label?: string
  lane: number
  onJump: (table: string, filter: RowFilter) => void
}) {
  if (id === null || id === undefined) return <span className="text-faint">NULL</span>
  return (
    <button
      type="button"
      title={`Open ${table} #${String(id)}`}
      onClick={() => onJump(table, { column: "id", op: "eq", value: String(id) })}
      className="-mx-1 inline-flex max-w-full items-center gap-1.5 rounded-[5px] px-1 text-left transition-colors hover:bg-hover"
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: laneVar(lane) }} />
      <span className="truncate font-sans text-[13.5px] underline decoration-[color-mix(in_oklab,var(--text)_25%,transparent)] decoration-dotted underline-offset-[3px]">
        {label ?? `#${String(id)}`}
      </span>
      {label && <span className="shrink-0 text-faint">#{String(id)}</span>}
    </button>
  )
}

function RelatedGroup({
  g,
  id,
  laneOf,
  onJump,
}: {
  g: RelatedOut
  id: number
  laneOf: (t: string) => number
  onJump: (table: string, filter: RowFilter) => void
}) {
  const others = g.columns.filter((c) => !c.is_pk && c.name !== g.column).slice(0, SUMMARY_VALUES)
  const showAll = () => onJump(g.table, { column: g.column, op: "eq", value: String(id) })
  return (
    <li className="rounded-control border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span aria-hidden className="size-2 rounded-full" style={{ background: laneVar(g.color_index) }} />
        <span className="font-mono text-[13px] text-text">{g.table}</span>
        <span className="font-mono text-[11.5px] text-faint">via {g.column}</span>
        <span className="num ml-auto text-[12.5px] text-text">
          {fmtInt(g.total)} {g.total === 1 ? "row" : "rows"}
        </span>
      </div>
      <ul className="divide-y divide-border font-mono text-[12px]">
        {g.rows.map((r) => (
          <li key={String(r.id)}>
            <button
              type="button"
              onClick={() => onJump(g.table, { column: "id", op: "eq", value: String(r.id) })}
              className="flex w-full items-baseline gap-3 px-3 py-1.5 text-left transition-colors hover:bg-hover"
            >
              <span className="w-10 shrink-0 text-right text-faint">#{String(r.id)}</span>
              <span className="min-w-0 truncate text-text">
                {others.map((c, i) => (
                  <span key={c.name}>
                    {i > 0 && <span className="text-faint">, </span>}
                    {c.fk ? (
                      (g.fk_labels[c.name]?.[String(r[c.name])] ?? <Plain v={r[c.name]} />)
                    ) : (
                      <Plain v={r[c.name]} />
                    )}
                  </span>
                ))}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={showAll}
        className="flex w-full items-center gap-1.5 border-t border-border px-3 py-2 text-[12.5px] transition-colors hover:bg-hover"
        style={{ color: laneVar(laneOf(g.table)) }}
      >
        {g.total > g.rows.length ? `Show all ${fmtInt(g.total)} in ${g.table}` : `Open in ${g.table}`}
        <ArrowRight size={13} />
      </button>
    </li>
  )
}

/**
 * One row in the side panel: its values (foreign keys open the row they point at), the records in other
 * tables that reference it (from the catalog's foreign keys), and Edit / Delete. A refused delete shows its
 * ConstraintCard right under the related records that caused it.
 */
export function RowView({
  wsId,
  table,
  lane,
  columns,
  laneOf,
  row,
  labels,
  onClose,
  onEdit,
  onDeleted,
  onJump,
}: {
  wsId: number
  table: string
  lane: number
  columns: DataColumn[]
  laneOf: (t: string) => number
  row: Row
  labels: Record<string, string>
  onClose: () => void
  onEdit: () => void
  onDeleted: (id: number) => void
  onJump: (table: string, filter: RowFilter) => void
}) {
  const id = Number(row.id)
  const related = useRelated(wsId, table, id)
  const del = useWriteRow(wsId)
  const [confirming, setConfirming] = useState(false)
  const [attempt, setAttempt] = useState(0)

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between gap-4 border-b border-border px-6 pb-4 pt-5">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-mono text-[12.5px] text-muted">
            <span aria-hidden className="size-2 rounded-full" style={{ background: laneVar(lane) }} />
            {table}
          </p>
          <h2 id="row-drawer-title" className="mt-1 text-[20px] font-medium tracking-[-0.02em]">
            Row {id}
          </h2>
        </div>
        <IconButton label="Close" onClick={onClose} className="-mr-2 mt-0.5">
          <X size={16} />
        </IconButton>
      </header>

      <div className="scrollbar-thin flex-1 overflow-y-auto px-6 py-5">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2.5 text-[13.5px]">
          {columns.map((c) => (
            <div key={c.name} className="contents">
              <dt className="pt-px font-mono text-[12.5px] text-muted">{c.name}</dt>
              <dd className="min-w-0 break-words font-mono text-text">
                {c.fk ? (
                  <FkLink
                    table={c.fk.table}
                    id={row[c.name]}
                    label={labels[c.name]}
                    lane={laneOf(c.fk.table)}
                    onJump={onJump}
                  />
                ) : (
                  <Plain v={row[c.name]} />
                )}
              </dd>
            </div>
          ))}
        </dl>

        <section aria-labelledby="related-h" className="mt-7">
          <h3 id="related-h" className="text-[14px] font-medium text-text">
            Referenced by
          </h3>
          <p className="mt-0.5 text-[12.5px] text-muted">Rows in other tables whose foreign key points at this one.</p>
          {related.isPending ? (
            <div className="py-6 text-center text-muted">
              <Spinner size={15} />
            </div>
          ) : related.error ? (
            <p className="mt-3 text-[13px] text-danger">{related.error.message}</p>
          ) : related.data.length === 0 ? (
            <p className="mt-3 rounded-control border border-dashed border-border-strong px-3 py-2.5 text-[13px] text-muted">
              Nothing references this row, so no foreign key stops it being deleted.
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-3">
              {related.data.map((g) => (
                <RelatedGroup key={`${g.table}.${g.column}`} g={g} id={id} laneOf={laneOf} onJump={onJump} />
              ))}
            </ul>
          )}
        </section>
      </div>

      <footer className="border-t border-border px-6 py-4">
        {del.error && (
          <div className="mb-4">
            <ConstraintCard key={attempt} error={del.error} onDismiss={() => del.reset()} />
          </div>
        )}
        {confirming ? (
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-[13.5px] text-text">Delete row {id}?</span>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
            <Button
              variant="danger"
              autoFocus
              loading={del.isPending}
              onClick={() => {
                setAttempt((n) => n + 1)
                del.mutate(
                  { op: "delete", table, id },
                  { onSuccess: () => onDeleted(id), onSettled: () => setConfirming(false) },
                )
              }}
            >
              Delete
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="danger"
              icon={<Trash2 size={14} />}
              className="mr-auto"
              onClick={() => {
                del.reset()
                setConfirming(true)
              }}
            >
              Delete
            </Button>
            <Button variant="primary" icon={<Pencil size={14} />} onClick={onEdit}>
              Edit
            </Button>
          </div>
        )}
      </footer>
    </div>
  )
}
