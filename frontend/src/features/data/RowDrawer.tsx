import { KeyRound, X } from "lucide-react"
import { useEffect, useId, useRef, useState, type FormEvent } from "react"
import { Button, IconButton } from "../../components/Button"
import { inputClass } from "../../components/Field"
import { laneVar } from "../../lib/lanes"
import { buildValues, inputKind, toInput } from "../../lib/rowValues"
import { constraintDetail, type DataColumn, type Row } from "./api"
import { ConstraintCard } from "./ConstraintCard"
import { FkPicker } from "./FkPicker"
import { RowView } from "./RowView"
import type { RowFilter } from "../../lib/rowFilters"
import { useWriteRow } from "./queries"

type FormMode = { kind: "add" } | { kind: "edit"; row: Row; labels: Record<string, string> }
/** view: the row's values and who references it; add / edit: the form. */
export type DrawerMode = FormMode | { kind: "view"; row: Row; labels: Record<string, string> }

/** What a successful save hands back: the row as stored, and the labels of the foreign keys picked. */
export interface Saved {
  row: Row
  labels: Record<string, string>
}

/**
 * The side panel for one row: view it (with its related records), edit it, or add a new one. The form is
 * generated from the catalog's column metadata; the database checks everything (NOT NULL, types, UNIQUE,
 * FOREIGN KEY) and a refusal shows as a ConstraintCard here.
 */
export function RowDrawer({
  wsId,
  table,
  lane,
  columns,
  laneOf,
  mode,
  onMode,
  onClose,
  onSaved,
  onDeleted,
  onJump,
}: {
  wsId: number
  table: string
  lane: number
  columns: DataColumn[]
  laneOf: (table: string) => number
  mode: DrawerMode | null
  onMode: (m: DrawerMode) => void
  onClose: () => void
  onSaved: (s: Saved, mode: DrawerMode) => void
  onDeleted: (id: number) => void
  onJump: (table: string, filter: RowFilter) => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (mode && !d.open) d.showModal()
    if (!mode && d.open) d.close()
  }, [mode])

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
      aria-labelledby="row-drawer-title"
      className={
        "dc-drawer fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-dvh w-full max-w-[460px] border-0 border-l " +
        "border-border-strong bg-raised p-0 text-text shadow-[var(--shadow-pop)]"
      }
    >
      {mode?.kind === "view" && (
        <RowView
          key={`view-${mode.row.id}`}
          wsId={wsId}
          table={table}
          lane={lane}
          columns={columns}
          laneOf={laneOf}
          row={mode.row}
          labels={mode.labels}
          onClose={onClose}
          onEdit={() => onMode({ kind: "edit", row: mode.row, labels: mode.labels })}
          onDeleted={onDeleted}
          onJump={onJump}
        />
      )}
      {mode && mode.kind !== "view" && (
        <RowForm
          // a fresh form per row (and per open), so no stale values carry over
          key={mode.kind === "edit" ? `edit-${mode.row.id}` : "add"}
          wsId={wsId}
          table={table}
          lane={lane}
          columns={columns}
          laneOf={laneOf}
          mode={mode}
          onClose={onClose}
          onSaved={(s) => onSaved(s, mode)}
        />
      )}
    </dialog>
  )
}

function RowForm({
  wsId,
  table,
  lane,
  columns,
  laneOf,
  mode,
  onClose,
  onSaved,
}: {
  wsId: number
  table: string
  lane: number
  columns: DataColumn[]
  laneOf: (table: string) => number
  mode: FormMode
  onClose: () => void
  onSaved: (s: Saved) => void
}) {
  const formId = useId()
  const write = useWriteRow(wsId)
  const original = mode.kind === "edit" ? mode.row : undefined
  const [form, setForm] = useState<Record<string, string>>(() =>
    Object.fromEntries(columns.map((c) => [c.name, toInput(original?.[c.name])])),
  )
  const [labels, setLabels] = useState<Record<string, string>>(mode.kind === "edit" ? mode.labels : {})
  const [attempt, setAttempt] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const firstField = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // showModal focuses the close button; start in the first field instead
    firstField.current?.querySelector<HTMLInputElement | HTMLSelectElement>("input,select")?.focus()
  }, [])

  const detail = constraintDetail(write.error)
  const flagged = new Set(detail?.columns ?? [])
  const editable = columns.filter((c) => !c.is_pk)
  const set = (name: string, v: string) => {
    setForm((f) => ({ ...f, [name]: v }))
    setNote(null)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const values = buildValues(columns, form, original)
    if (mode.kind === "edit" && Object.keys(values).length === 0) {
      setNote("Nothing has changed yet.")
      return
    }
    setAttempt((n) => n + 1)
    const req =
      mode.kind === "edit"
        ? { op: "update" as const, table, id: Number(mode.row.id), values }
        : { op: "insert" as const, table, values }
    write.mutate(req, { onSuccess: (row) => row && onSaved({ row, labels }) })
  }

  const title = mode.kind === "edit" ? `Edit row ${mode.row.id}` : `Add a row`

  return (
    <form id={formId} onSubmit={submit} className="flex h-full flex-col">
      <header className="flex items-start justify-between gap-4 border-b border-border px-6 pb-4 pt-5">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-mono text-[12.5px] text-muted">
            <span aria-hidden className="size-2 rounded-full" style={{ background: laneVar(lane) }} />
            {table}
          </p>
          <h2 id="row-drawer-title" className="mt-1 text-[20px] font-medium tracking-[-0.02em]">
            {title}
          </h2>
        </div>
        <IconButton label="Close" onClick={onClose} className="-mr-2 mt-0.5">
          <X size={16} />
        </IconButton>
      </header>

      <div className="scrollbar-thin flex-1 overflow-y-auto px-6 py-5">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between rounded-control border border-dashed border-border-strong px-3 py-2 text-[13px] text-muted">
            <span className="flex items-center gap-2 font-mono text-[12.5px]">
              <KeyRound size={13} aria-hidden className="text-faint" />
              id
            </span>
            <span className="font-mono text-[12.5px]">
              {mode.kind === "edit" ? String(mode.row.id) : "generated by the database"}
            </span>
          </div>

          {editable.map((c, i) => {
            const fieldId = `${formId}-${c.name}`
            const invalid = flagged.has(c.name)
            const kind = inputKind(c.data_type)
            return (
              <div key={c.name} ref={i === 0 ? firstField : undefined} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <label htmlFor={fieldId} className="font-mono text-[13px] font-medium text-text">
                    {c.name}
                    {c.not_null && (
                      <span className="ml-1 text-danger" title="Required: the column is NOT NULL">
                        *
                      </span>
                    )}
                  </label>
                  <span className="font-mono text-[11.5px] text-faint">{c.fk ? `→ ${c.fk.table}` : c.data_type}</span>
                </div>
                {c.fk ? (
                  <FkPicker
                    wsId={wsId}
                    table={table}
                    column={c.name}
                    refTable={c.fk.table}
                    refLane={laneOf(c.fk.table)}
                    value={form[c.name]}
                    label={labels[c.name] ?? null}
                    invalid={invalid}
                    inputId={fieldId}
                    onChange={(id, label) => {
                      set(c.name, id)
                      setLabels((l) => {
                        const next = { ...l }
                        if (label === null) delete next[c.name]
                        else next[c.name] = label
                        return next
                      })
                    }}
                  />
                ) : kind === "boolean" ? (
                  <select
                    id={fieldId}
                    className={inputClass}
                    aria-invalid={invalid || undefined}
                    value={form[c.name]}
                    onChange={(e) => set(c.name, e.target.value)}
                  >
                    <option value="">NULL</option>
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <input
                    id={fieldId}
                    type={kind === "date" ? "date" : "text"}
                    inputMode={kind === "integer" ? "numeric" : kind === "decimal" ? "decimal" : undefined}
                    autoComplete="off"
                    spellCheck={false}
                    aria-required={c.not_null || undefined}
                    aria-invalid={invalid || undefined}
                    placeholder={c.not_null ? "" : "NULL"}
                    className={`${inputClass} ${kind === "text" ? "" : "font-mono"} ${kind === "integer" || kind === "decimal" ? "text-right" : ""}`}
                    value={form[c.name]}
                    onChange={(e) => set(c.name, e.target.value)}
                  />
                )}
              </div>
            )
          })}
        </div>

        <p className="mt-5 text-[12.5px] leading-relaxed text-muted">
          <span className="text-danger">*</span> NOT NULL. A blank field is sent as NULL. The form checks nothing
          itself: PostgreSQL applies the table's constraints when you save.
        </p>
      </div>

      <footer className="border-t border-border px-6 py-4">
        {write.error && (
          <div className="mb-4">
            <ConstraintCard key={attempt} error={write.error} />
          </div>
        )}
        {note && <p className="mb-3 text-[13px] text-muted">{note}</p>}
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={write.isPending}>
            {mode.kind === "edit" ? "Save changes" : "Add row"}
          </Button>
        </div>
      </footer>
    </form>
  )
}
