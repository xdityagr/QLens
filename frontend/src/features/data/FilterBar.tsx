import { ListFilter, X } from "lucide-react"
import { useState, type FormEvent } from "react"
import { Button } from "../../components/Button"
import { inputClass } from "../../components/Field"
import { describeFilter, OP_LABEL, opsFor, type FilterOp, type RowFilter } from "../../lib/rowFilters"
import { inputKind } from "../../lib/rowValues"
import type { DataColumn } from "./api"

const selectClass =
  "h-8 rounded-control border border-border-strong bg-raised px-2 font-mono text-[12.5px] text-text outline-none focus:border-accent"

/**
 * Active filters as removable chips, and an inline row to add one: column, operator, value. Every filter
 * is a WHERE condition the server builds with the value as a bound parameter; they are ANDed.
 */
export function FilterBar({
  columns,
  filters,
  onChange,
}: {
  columns: DataColumn[]
  filters: RowFilter[]
  onChange: (next: RowFilter[]) => void
}) {
  const [adding, setAdding] = useState(false)
  const [column, setColumn] = useState(columns[1]?.name ?? columns[0]?.name ?? "")
  const col = columns.find((c) => c.name === column) ?? columns[0]
  const ops = col ? opsFor(col) : []
  const [op, setOp] = useState<FilterOp>(ops[0] ?? "eq")
  const [value, setValue] = useState("")
  const effectiveOp = ops.includes(op) ? op : ops[0]

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!col || (effectiveOp !== "empty" && value.trim() === "")) return
    onChange([...filters, { column: col.name, op: effectiveOp, value: effectiveOp === "empty" ? "" : value.trim() }])
    setValue("")
    setAdding(false)
  }

  if (filters.length === 0 && !adding)
    return (
      <div className="mb-3">
        <Button
          size="sm"
          variant="ghost"
          icon={<ListFilter size={14} />}
          onClick={() => setAdding(true)}
          className="-ml-2"
        >
          Filter by a column
        </Button>
      </div>
    )

  const kind = col ? inputKind(col.data_type) : "text"
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {filters.map((f, i) => (
        <span
          key={`${f.column}-${f.op}-${f.value}-${i}`}
          className="dc-pop inline-flex h-8 items-center gap-1.5 rounded-full border border-border-strong bg-raised pl-3 pr-1 font-mono text-[12px] text-text"
        >
          {describeFilter(f)}
          <button
            type="button"
            aria-label={`Remove filter ${describeFilter(f)}`}
            onClick={() => onChange(filters.filter((_, j) => j !== i))}
            className="grid size-6 place-items-center rounded-full text-muted transition-colors hover:bg-hover hover:text-text"
          >
            <X size={12} />
          </button>
        </span>
      ))}

      {adding ? (
        <form onSubmit={submit} className="dc-pop flex flex-wrap items-center gap-1.5" aria-label="Add a filter">
          <select
            aria-label="Column"
            className={selectClass}
            value={column}
            onChange={(e) => setColumn(e.target.value)}
          >
            {columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Condition"
            className={selectClass}
            value={effectiveOp}
            onChange={(e) => setOp(e.target.value as FilterOp)}
          >
            {ops.map((o) => (
              <option key={o} value={o}>
                {o === "contains" && col?.fk ? `contains (${col.fk.table})` : OP_LABEL[o]}
              </option>
            ))}
          </select>
          {effectiveOp !== "empty" &&
            (kind === "boolean" && !col?.fk ? (
              <select
                aria-label="Value"
                className={selectClass}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              >
                <option value="">choose</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              // inputClass is full width; the wrapper sets the size
              <span className="w-44">
                <input
                  aria-label="Value"
                  autoFocus
                  type={kind === "date" && !col?.fk ? "date" : "text"}
                  inputMode={effectiveOp === "eq" && col?.fk ? "numeric" : undefined}
                  placeholder={col?.fk ? (effectiveOp === "eq" ? "id" : `${col.fk.table} name`) : "value"}
                  className={`${inputClass} h-8 font-mono text-[12.5px]`}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </span>
            ))}
          <Button size="sm" type="submit" variant="secondary" className="h-8">
            Add
          </Button>
          <Button size="sm" type="button" variant="ghost" className="h-8" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <Button size="sm" variant="ghost" icon={<ListFilter size={14} />} onClick={() => setAdding(true)}>
          Add filter
        </Button>
      )}
      {filters.length > 1 && !adding && (
        <button type="button" onClick={() => onChange([])} className="text-[12.5px] text-muted hover:text-text">
          Clear all
        </button>
      )}
    </div>
  )
}
