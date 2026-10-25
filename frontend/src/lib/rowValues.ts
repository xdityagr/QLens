// Row values between the Data screen's form, the API and the audit log. Pure; tested in rowValues.test.ts.

type CellLike = string | number | boolean | null | undefined

export interface ColumnLike {
  name: string
  data_type: string
  not_null: boolean
  is_pk: boolean
  fk: { table: string; column: string } | null
}

export type InputKind = "integer" | "decimal" | "boolean" | "date" | "text"

/** Which input a column gets. Anything unfamiliar is plain text; PostgreSQL still checks it. */
export function inputKind(dataType: string): InputKind {
  const t = dataType.toLowerCase()
  if (/^(bigint|integer|smallint|int[248]?)$/.test(t)) return "integer"
  if (/^(numeric|decimal)(\(|$)|^(real|double precision)$/.test(t)) return "decimal"
  if (t === "boolean") return "boolean"
  if (t === "date") return "date"
  return "text"
}

/** A cell as an input's value: NULL is the empty string. */
export function toInput(v: CellLike): string {
  if (v === null || v === undefined) return ""
  return String(v)
}

/**
 * What the form sends for one field. Blank is NULL, so a NOT NULL column left blank is refused by the
 * database, not by the form. Numbers stay text: PostgreSQL parses them into the column type and its own
 * error names the value it could not read.
 */
export function coerce(raw: string, col: ColumnLike): string | number | boolean | null {
  const v = raw.trim()
  if (v === "") return null
  if (col.fk && /^\d+$/.test(v)) return Number(v)
  if (inputKind(col.data_type) === "boolean" && (v === "true" || v === "false")) return v === "true"
  return v
}

/**
 * The values to send: every writable column for a new row, only the changed ones for an edit. The id is
 * never sent; the database generates it.
 */
export function buildValues(
  columns: ColumnLike[],
  form: Record<string, string>,
  original?: Record<string, CellLike>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {}
  for (const c of columns) {
    if (c.is_pk) continue
    const raw = form[c.name] ?? ""
    if (original && raw.trim() === toInput(original[c.name]).trim()) continue
    out[c.name] = coerce(raw, c)
  }
  return out
}

export interface DiffEntry {
  column: string
  before: CellLike
  after: CellLike
  changed: boolean
}

/**
 * Column by column, a change from the audit log. An INSERT has only `after`, a DELETE only `before`;
 * every column of those counts as changed. The id is the row's identity, not a value, so it is left out.
 */
export function diffRow(before: Record<string, CellLike> | null, after: Record<string, CellLike> | null): DiffEntry[] {
  const cols = [...new Set([...Object.keys(after ?? {}), ...Object.keys(before ?? {})])].filter((c) => c !== "id")
  return cols.map((column) => {
    const b = before ? before[column] : undefined
    const a = after ? after[column] : undefined
    const changed = before === null || after === null || !Object.is(b, a)
    return { column, before: b, after: a, changed }
  })
}
