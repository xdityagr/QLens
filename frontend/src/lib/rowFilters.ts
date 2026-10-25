// Column filters on the Data screen, in the API's `column:op:value` form (backend/qlens/data/service.py Filter).
import { inputKind, type ColumnLike } from "./rowValues"

export type FilterOp = "eq" | "contains" | "gt" | "lt" | "empty"
export const FILTER_OPS: FilterOp[] = ["eq", "contains", "gt", "lt", "empty"]

export interface RowFilter {
  column: string
  op: FilterOp
  /** "" for `empty` */
  value: string
}

export const OP_LABEL: Record<FilterOp, string> = {
  eq: "=",
  contains: "contains",
  gt: ">",
  lt: "<",
  empty: "is empty",
}

export function formatFilter(f: RowFilter): string {
  return f.op === "empty" ? `${f.column}:empty` : `${f.column}:${f.op}:${f.value}`
}

/** The inverse of formatFilter; null for anything malformed (a hand-edited URL, say). */
export function parseFilter(raw: string): RowFilter | null {
  const i = raw.indexOf(":")
  if (i <= 0) return null
  const column = raw.slice(0, i)
  const rest = raw.slice(i + 1)
  const j = rest.indexOf(":")
  const op = (j < 0 ? rest : rest.slice(0, j)) as FilterOp
  if (!FILTER_OPS.includes(op)) return null
  if (op === "empty") return { column, op, value: "" }
  if (j < 0) return null
  return { column, op, value: rest.slice(j + 1) }
}

/**
 * The operators a column offers. A foreign key is matched by what it stands for (contains) or by id (=);
 * ordering only makes sense for numbers and dates.
 */
export function opsFor(col: ColumnLike): FilterOp[] {
  if (col.fk) return ["contains", "eq", "empty"]
  const kind = inputKind(col.data_type)
  if (kind === "boolean") return ["eq", "empty"]
  if (kind === "text") return ["contains", "eq", "empty"]
  return ["eq", "gt", "lt", "empty"]
}

export function describeFilter(f: RowFilter): string {
  if (f.op === "empty") return `${f.column} is empty`
  if (f.op === "contains") return `${f.column} contains “${f.value}”`
  return `${f.column} ${OP_LABEL[f.op]} ${f.value}`
}
