import { ArrowDown, ArrowUp, ArrowUpDown, KeyRound, Link2, Pencil, Trash2 } from "lucide-react"
import { Button, IconButton } from "../../components/Button"
import { laneVar } from "../../lib/lanes"
import { inputKind } from "../../lib/rowValues"
import type { Cell } from "../../lib/types"
import type { DataColumn, Row, RowsOut } from "./api"

export interface Pinned {
  row: Row
  labels: Record<string, string>
}

export interface SortState {
  sort: string | null
  dir: "asc" | "desc"
}

function CellValue({
  v,
  col,
  label,
  refLane,
  onJump,
}: {
  v: Cell
  col: DataColumn
  label?: string
  refLane?: number
  onJump?: (table: string, id: number) => void
}) {
  if (v === null || v === undefined) return <span className="text-faint">NULL</span>
  if (col.fk && refLane !== undefined)
    return (
      <button
        type="button"
        title={`Open ${col.fk.table} #${String(v)}`}
        onClick={(e) => {
          e.stopPropagation()
          onJump?.(col.fk!.table, Number(v))
        }}
        className="-mx-1 inline-flex max-w-full items-center gap-1.5 rounded-[5px] px-1 transition-colors hover:bg-[color-mix(in_oklab,var(--text)_8%,transparent)]"
      >
        <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: laneVar(refLane) }} />
        <span className="truncate font-sans text-[13px] text-text underline decoration-[color-mix(in_oklab,var(--text)_25%,transparent)] decoration-dotted underline-offset-[3px]">
          {label ?? "?"}
        </span>
        <span className="shrink-0 text-faint">#{String(v)}</span>
      </button>
    )
  if (typeof v === "boolean") return v ? "true" : "false"
  return String(v)
}

/**
 * The rows of one table: sticky header with sort, mono values, foreign keys shown by what they point at
 * (click one to open that row), a row click opens its side panel, edit and delete per row (delete asks
 * first, inline). Rows added this session are pinned on top.
 */
export function RowGrid({
  data,
  laneOf,
  sort,
  onSort,
  pinned,
  flash,
  leaving,
  confirmId,
  deletingId,
  onOpen,
  onEdit,
  onJump,
  onAskDelete,
  onDelete,
  onCancelDelete,
}: {
  data: RowsOut
  laneOf: (table: string) => number
  sort: SortState
  onSort: (column: string) => void
  pinned: Pinned[]
  /** row id -> columns that just changed */
  flash: Map<number, Set<string>>
  leaving: Set<number>
  confirmId: number | null
  deletingId: number | null
  /** the row's side panel: its values and the records that reference it */
  onOpen: (row: Row, labels: Record<string, string>) => void
  onEdit: (row: Row, labels: Record<string, string>) => void
  /** a foreign-key value was clicked: show that row of the referenced table */
  onJump: (table: string, id: number) => void
  onAskDelete: (id: number) => void
  onDelete: (id: number) => void
  onCancelDelete: () => void
}) {
  const cols = data.columns
  const numeric = (c: DataColumn) => !c.fk && (c.is_pk || ["integer", "decimal"].includes(inputKind(c.data_type)))
  const pageIds = new Set(data.rows.map((r) => Number(r.id)))
  const top = pinned.filter((p) => !pageIds.has(Number(p.row.id)))
  const labelsOf = (r: Row): Record<string, string> =>
    Object.fromEntries(
      cols
        .filter((c) => c.fk && r[c.name] !== null)
        .map((c) => [c.name, data.fk_labels[c.name]?.[String(r[c.name])]] as const)
        .filter((e): e is [string, string] => e[1] !== undefined),
    )

  const renderRow = (r: Row, labels: Record<string, string>, isPinned: boolean) => {
    const id = Number(r.id)
    const changed = flash.get(id)
    const confirming = confirmId === id
    return (
      <tr
        key={`${isPinned ? "p" : "r"}-${id}`}
        tabIndex={0}
        aria-label={`Row ${id}: open details`}
        onClick={() => !confirming && onOpen(r, labels)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.target === e.currentTarget) onOpen(r, labels)
        }}
        className={
          "group cursor-pointer outline-offset-[-2px] " +
          (leaving.has(id) ? "dc-row-out " : isPinned ? "dc-row-in " : "") +
          (confirming ? "bg-[color-mix(in_oklab,var(--danger)_8%,transparent)]" : "hover:bg-hover")
        }
      >
        {cols.map((c) => (
          <td
            key={c.name}
            className={
              "max-w-[22rem] truncate border-b border-border px-3 py-2 " +
              (c.is_pk ? "text-muted " : "text-text ") +
              (numeric(c) ? "text-right tabular-nums " : "") +
              (changed?.has(c.name) ? "dc-flash" : "")
            }
          >
            {c.is_pk && isPinned ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="rounded-full bg-[color-mix(in_oklab,var(--lane-4)_14%,transparent)] px-1.5 font-sans text-[10.5px] font-medium text-lane-4">
                  new
                </span>
                {String(r.id)}
              </span>
            ) : (
              <CellValue
                v={r[c.name]}
                col={c}
                label={labels[c.name]}
                refLane={c.fk ? laneOf(c.fk.table) : undefined}
                onJump={onJump}
              />
            )}
          </td>
        ))}
        <td
          className="sticky right-0 cursor-default border-b border-border bg-surface px-2 py-1 text-right group-hover:bg-hover"
          // the action cell is not part of "open the row"
          onClick={(e) => e.stopPropagation()}
        >
          {confirming ? (
            <span className="flex items-center justify-end gap-1.5 font-sans">
              <span className="mr-1 whitespace-nowrap text-[12.5px] text-text">Delete row {id}?</span>
              <Button size="sm" variant="ghost" onClick={onCancelDelete} className="h-7 px-2">
                Keep
              </Button>
              <Button
                size="sm"
                variant="danger"
                autoFocus
                loading={deletingId === id}
                onClick={() => onDelete(id)}
                className="h-7 px-2"
              >
                Delete
              </Button>
            </span>
          ) : (
            <span className="flex items-center justify-end gap-0.5 opacity-60 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
              <IconButton label={`Edit row ${id}`} onClick={() => onEdit(r, labels)} className="size-7">
                <Pencil size={14} />
              </IconButton>
              <IconButton
                label={`Delete row ${id}`}
                onClick={() => onAskDelete(id)}
                className="size-7 hover:text-danger"
              >
                <Trash2 size={14} />
              </IconButton>
            </span>
          )}
        </td>
      </tr>
    )
  }

  return (
    <div className="scrollbar-thin max-h-[min(62vh,640px)] overflow-auto rounded-card border border-border bg-surface">
      <table className="w-full min-w-max border-separate border-spacing-0 font-mono text-[12.5px]">
        <thead>
          <tr>
            {cols.map((c) => {
              const active = sort.sort === c.name
              const Icon = active ? (sort.dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown
              return (
                <th
                  key={c.name}
                  scope="col"
                  aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                  className="sticky top-0 z-10 border-b border-border bg-raised p-0 text-left font-medium text-text"
                >
                  <button
                    type="button"
                    onClick={() => onSort(c.name)}
                    title={`Sort by ${c.name}`}
                    className={
                      "group/h flex w-full items-center gap-1.5 px-3 py-2 transition-colors hover:bg-hover " +
                      (numeric(c) ? "justify-end" : "")
                    }
                  >
                    {c.is_pk && <KeyRound size={12} className="text-lane-6" aria-label="primary key" />}
                    {c.fk && (
                      <Link2
                        size={12}
                        style={{ color: laneVar(laneOf(c.fk.table)) }}
                        aria-label={`references ${c.fk.table}`}
                      />
                    )}
                    <span>{c.name}</span>
                    <span className="font-normal text-faint">{c.fk ? `→ ${c.fk.table}` : c.data_type}</span>
                    <Icon
                      size={12}
                      aria-hidden
                      className={
                        active ? "text-accent" : "text-faint opacity-0 transition-opacity group-hover/h:opacity-100"
                      }
                    />
                  </button>
                </th>
              )
            })}
            <th
              scope="col"
              className="sticky right-0 top-0 z-20 w-px whitespace-nowrap border-b border-border bg-raised px-3 py-2"
            >
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {top.map((p) => renderRow(p.row, p.labels, true))}
          {data.rows.map((r) => renderRow(r, labelsOf(r), false))}
        </tbody>
      </table>
      {data.rows.length === 0 && top.length === 0 && (
        <p className="px-4 py-10 text-center font-sans text-[13.5px] text-muted">No rows match.</p>
      )}
    </div>
  )
}
