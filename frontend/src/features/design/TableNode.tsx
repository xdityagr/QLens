import { Handle, Position, type NodeProps } from "@xyflow/react"
import { KeyRound, Link2 } from "lucide-react"
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react"
import { fmtInt } from "../../lib/format"
import { columnHandle, ER_HEADER_H, ER_PAD_Y, ER_ROW_H, PK_HANDLE, type ErNode } from "../../lib/graphLayout"
import { laneVar } from "../../lib/lanes"
import type { ProposedColumnOut, TableOut } from "../../lib/types"
import { useEr, type RenameTarget } from "./erContext"

const HANDLE_STYLE: CSSProperties = { opacity: 0, width: 6, height: 6, minWidth: 0, minHeight: 0, border: 0 }

/**
 * One proposed table: lane stripe, name, then its columns in mono with key and link markers.
 * Double-click a name to rename it (drafts only); errors from the server show right under it.
 * The surrogate key `id` is never renamable: the Data page, its audit trigger and Browse address rows by it.
 */
export function TableNode({ data }: NodeProps<ErNode>) {
  const { table } = data
  const er = useEr()
  const lane = laneVar(table.color_index)
  const rows = er.rowCounts?.get(table.name)
  const hot = er.hovered === table.id
  const dim = er.hovered !== null && !hot && !er.related?.has(table.id)

  return (
    <div
      className="er-card"
      data-hot={hot}
      data-dim={dim}
      style={{ "--er-lane": lane } as CSSProperties}
      onMouseEnter={() => er.setHovered(table.id)}
      onMouseLeave={() => er.setHovered(null)}
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] rounded-l-[9px]" style={{ background: lane }} />
      <header className="flex items-center gap-3 border-b border-border pl-4 pr-3.5" style={{ height: ER_HEADER_H }}>
        <EditableName
          value={table.name}
          target={{ kind: "table", id: table.id }}
          label={`table ${table.name}`}
          className="text-[15px] font-semibold tracking-[-0.015em] text-text"
        />
        {rows !== undefined && (
          <span className="num ml-auto shrink-0 text-[11px] text-muted" title="Rows in the applied table">
            {fmtInt(rows)} {rows === 1 ? "row" : "rows"}
          </span>
        )}
      </header>
      <ul style={{ paddingBlock: ER_PAD_Y }}>
        {table.columns.map((c) => (
          <ColumnRow key={c.id} table={table} column={c} />
        ))}
      </ul>
    </div>
  )
}

function ColumnRow({ table, column: c }: { table: TableOut; column: ProposedColumnOut }) {
  const er = useEr()
  const keys = table.unique_keys.filter((k) => k.includes(c.name))
  const unique = c.role !== "pk" && keys.length > 0
  const refLane = c.references_table_id !== null ? er.laneOf.get(c.references_table_id) : undefined

  let icon
  if (c.role === "pk") icon = <KeyRound size={13} strokeWidth={2} className="text-muted" aria-label="primary key" />
  else if (c.role === "fk")
    icon = (
      <Link2
        size={13}
        strokeWidth={2.25}
        style={{ color: refLane !== undefined ? laneVar(refLane) : "var(--muted)" }}
        aria-label="foreign key"
      />
    )
  else icon = <span aria-hidden className="size-[13px]" />

  return (
    <li className="er-row relative flex items-center gap-2 pl-4 pr-3.5" style={{ height: ER_ROW_H }}>
      {icon}
      <EditableName
        value={c.name}
        target={{ kind: "column", id: c.id }}
        label={`column ${c.name}`}
        className={"font-mono text-[12.5px] " + (c.role === "attribute" ? "text-text" : "text-muted")}
        readOnlyReason={c.role === "pk" ? PK_READ_ONLY : undefined}
        hint={
          c.source_label === null
            ? undefined
            : c.role === "fk"
              ? `Stands for the sheet's "${c.source_label}" column.`
              : `From the sheet's "${c.source_label}" column.`
        }
      />
      {unique && (
        <span
          className="rounded-[4px] border border-border-strong px-1 font-mono text-[9.5px] leading-[14px] text-muted"
          title={uniqueTitle(c.name, keys)}
        >
          UQ
        </span>
      )}
      <span className="ml-auto pl-2 font-mono text-[11px] text-faint" title={c.not_null ? undefined : "Can be empty"}>
        {c.data_type}
        {!c.not_null && <span className="text-muted">?</span>}
      </span>
      {c.role === "pk" && (
        <Handle type="target" position={Position.Right} id={PK_HANDLE} style={HANDLE_STYLE} isConnectable={false} />
      )}
      {c.role === "fk" && (
        <Handle
          type="source"
          position={Position.Left}
          id={columnHandle(c.id)}
          style={HANDLE_STYLE}
          isConnectable={false}
        />
      )}
    </li>
  )
}

export const PK_READ_ONLY =
  "The id column is the surrogate primary key and keeps its name: the Data page and its audit log find rows by id."

function uniqueTitle(name: string, keys: string[][]): string {
  const together = keys.find((k) => k.length > 1)
  if (keys.some((k) => k.length === 1)) return "Unique: no two rows share this value"
  return `Unique together with ${together!.filter((n) => n !== name).join(" + ")}`
}

function EditableName({
  value,
  target,
  label,
  className,
  hint,
  readOnlyReason,
}: {
  value: string
  target: RenameTarget
  label: string
  className: string
  /** where it came from in the sheet, shown on hover */
  hint?: string
  /** set for a name that can never be renamed; shown on hover instead of the rename hint */
  readOnlyReason?: string
}) {
  const er = useEr()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const errId = useId()

  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])
  // after a refused name, keep the caret in the field so it can be fixed or cancelled with Escape
  useEffect(() => {
    if (error) input.current?.focus()
  }, [error])

  function start() {
    if (!er.editable || readOnlyReason) return
    setDraft(value)
    setError(null)
    setEditing(true)
  }
  function cancel() {
    setEditing(false)
    setError(null)
  }
  async function commit() {
    const name = draft.trim()
    if (!name || name === value) return cancel()
    setSaving(true)
    try {
      await er.rename(target, name)
      setEditing(false)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't rename.")
    } finally {
      setSaving(false)
    }
  }
  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    e.stopPropagation() // keep Backspace etc. away from React Flow's shortcuts
    if (e.key === "Enter") void commit()
    else if (e.key === "Escape") cancel()
  }

  if (editing)
    return (
      <span className="relative min-w-0">
        <input
          ref={input}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            setError(null)
          }}
          onKeyDown={onKey}
          onBlur={() => {
            if (!saving && !error) void commit()
          }}
          readOnly={saving}
          spellCheck={false}
          autoCapitalize="off"
          aria-label={`Rename ${label}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errId : undefined}
          size={Math.max(4, draft.length + 1)}
          className={`er-input nodrag nopan nowheel max-w-[240px] ${className}`}
        />
        {error && (
          <span
            id={errId}
            role="alert"
            className="er-pop absolute left-0 top-full z-20 mt-1.5 w-[230px] rounded-control border border-border-strong bg-raised px-2.5 py-1.5 font-sans text-[12px] font-normal leading-snug tracking-normal text-danger shadow-[var(--shadow-pop)]"
          >
            {error}
          </span>
        )}
      </span>
    )

  if (readOnlyReason)
    return (
      <span className={`min-w-0 truncate px-0.5 ${className}`} title={readOnlyReason} data-readonly="pk">
        {value}
      </span>
    )

  return (
    <button
      type="button"
      className={`er-name-btn min-w-0 truncate px-0.5 text-left ${className}`}
      data-editable={er.editable}
      onDoubleClick={start}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "F2") {
          e.preventDefault()
          start()
        }
      }}
      title={
        (hint ? hint + " " : "") +
        (er.editable ? "Double-click to rename" : "Applied designs are read-only. Start a new draft to rename.")
      }
    >
      {value}
    </button>
  )
}
