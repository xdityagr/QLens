import type { ReactNode } from "react"
import { laneVar } from "../lib/lanes"

export interface GridColumn {
  name: string
  type?: string
  /** lane of the table this column belongs to, if any */
  lane?: number
}

type Cell = string | number | boolean | null | undefined

function renderCell(v: Cell): ReactNode {
  if (v === null || v === undefined) return <span className="text-faint">NULL</span>
  if (typeof v === "boolean") return v ? "true" : "false"
  return String(v)
}

/**
 * Plain result grid: mono, sticky header, row numbers. Not virtualized; the API
 * caps results at 1000 rows, which a plain table renders fine.
 */
export function DataGrid({
  columns,
  rows,
  maxHeight = 480,
  className = "",
}: {
  columns: GridColumn[]
  rows: Cell[][]
  maxHeight?: number | string
  className?: string
}) {
  return (
    <div
      className={`scrollbar-thin overflow-auto rounded-card border border-border bg-surface ${className}`}
      style={{ maxHeight }}
    >
      <table className="w-max min-w-full border-separate border-spacing-0 font-mono text-[12.5px]">
        <thead>
          <tr>
            <th className="sticky left-0 top-0 z-20 border-b border-r border-border bg-raised px-3 py-2 text-right font-normal text-faint">
              #
            </th>
            {columns.map((c) => (
              <th
                key={c.name}
                scope="col"
                className="sticky top-0 z-10 border-b border-border bg-raised px-3 py-2 text-left font-medium text-text"
              >
                <span className="flex items-center gap-2">
                  {c.lane !== undefined && (
                    <span aria-hidden className="size-1.5 rounded-full" style={{ background: laneVar(c.lane) }} />
                  )}
                  {c.name}
                  {c.type && <span className="font-normal text-faint">{c.type}</span>}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="hover:bg-hover">
              <td className="sticky left-0 border-b border-r border-border bg-surface px-3 py-1.5 text-right tabular-nums text-faint">
                {i + 1}
              </td>
              {row.map((v, j) => (
                <td
                  key={j}
                  className={
                    "max-w-[28rem] truncate border-b border-border px-3 py-1.5 text-text " +
                    (typeof v === "number" ? "text-right tabular-nums" : "")
                  }
                >
                  {renderCell(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="px-4 py-6 text-center font-sans text-[13px] text-muted">No rows.</p>}
    </div>
  )
}
