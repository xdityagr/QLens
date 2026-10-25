import { api, ApiError } from "../../lib/api"
import type { Cell } from "../../lib/types"

// Mirrors backend/qlens/data/routes.py and service.py.

export interface DataColumn {
  name: string
  /** PostgreSQL type as format_type() prints it, e.g. "bigint", "numeric", "text", "date" */
  data_type: string
  not_null: boolean
  is_pk: boolean
  fk: { table: string; column: string } | null
}

export type Row = Record<string, Cell>

export interface RowsOut {
  table: string
  color_index: number
  columns: DataColumn[]
  /** UNIQUE constraints other than the primary key, as column lists */
  unique_keys: string[][]
  rows: Row[]
  /** fk column -> { id (as a string) -> label of the referenced row } for the ids on this page */
  fk_labels: Record<string, Record<string, string>>
  total: number
  page: number
  page_size: number
}

export interface FkOption {
  id: number
  label: string
}

export type ChangeOp = "INSERT" | "UPDATE" | "DELETE"

export interface ChangeOut {
  id: number
  table_name: string
  op: ChangeOp
  row_pk: number | null
  before: Row | null
  after: Row | null
  changed_at: string
}

export interface ChangesOut {
  /** distinct rows changed since the design was last applied */
  edited_rows: number
  /** every INSERT, UPDATE and DELETE since then */
  change_count: number
  changes: ChangeOut[]
}

/** `detail` of a 409/422 from a write: which rule PostgreSQL enforced, and how. */
export interface ConstraintDetail {
  kind: "unique" | "foreign_key" | "not_null" | "check" | "invalid_input" | "other"
  sqlstate: string
  constraint: string | null
  columns: string[]
  table: string
  operation: ChangeOp
  /** the rule as pg_get_constraintdef prints it, e.g. "FOREIGN KEY (student_id) REFERENCES ws_3.students(id)" */
  definition: string | null
  server_message: string
  referencing_table?: string
  referencing_rows?: number
  referenced_table?: string | null
}

/** The error carries a rule PostgreSQL enforced (as opposed to, say, a network failure). */
export function constraintDetail(e: unknown): ConstraintDetail | null {
  if (!(e instanceof ApiError)) return null
  const d = e.detail as Partial<ConstraintDetail> | undefined
  return d && typeof d === "object" && typeof d.sqlstate === "string" && typeof d.kind === "string"
    ? (d as ConstraintDetail)
    : null
}

/** What a write sends: values as text (PostgreSQL parses them into the column type), numbers, booleans or null. */
export type WriteValue = string | number | boolean | null

export interface RowsParams {
  page: number
  pageSize: number
  sort: string | null
  dir: "asc" | "desc"
  q: string
  /** column filters in the API's column:op:value form, ANDed */
  filters: string[]
}

/** POST /query/write: one INSERT, UPDATE or DELETE from the SQL tab, committed (backend/qlens/query/routes.py). */
export interface SqlWriteOut {
  run_id: number
  statement: ChangeOp
  table: string
  /** rows affected */
  row_count: number
  /** what RETURNING gave, at most 50 rows; null without RETURNING */
  returning: { columns: { name: string; type: string }[]; rows: Cell[][]; truncated: boolean } | null
  duration_ms: number
}

/** Rows of another table that point at one row (GET /data/{table}/{id}/related). */
export interface RelatedOut {
  table: string
  /** the foreign-key column in that table */
  column: string
  color_index: number
  total: number
  columns: DataColumn[]
  /** the first few, by id */
  rows: Row[]
  fk_labels: Record<string, Record<string, string>>
}

function viewQuery(p: Omit<RowsParams, "page" | "pageSize">): URLSearchParams {
  const qs = new URLSearchParams({ dir: p.dir })
  if (p.sort) qs.set("sort", p.sort)
  if (p.q.trim()) qs.set("q", p.q.trim())
  for (const f of p.filters) qs.append("f", f)
  return qs
}

const base = (wsId: number) => `/api/workspaces/${wsId}`
const enc = encodeURIComponent

export const dataApi = {
  rows: (wsId: number, table: string, p: RowsParams) => {
    const qs = viewQuery(p)
    qs.set("page", String(p.page))
    qs.set("page_size", String(p.pageSize))
    return api<RowsOut>(`${base(wsId)}/data/${enc(table)}?${qs}`)
  },
  /** A plain link (the session cookie goes with it), so the browser downloads the CSV itself. */
  exportUrl: (wsId: number, table: string, p: Omit<RowsParams, "page" | "pageSize">) =>
    `${base(wsId)}/data/${enc(table)}/export?${viewQuery(p)}`,
  related: (wsId: number, table: string, id: number) =>
    api<RelatedOut[]>(`${base(wsId)}/data/${enc(table)}/${id}/related`),
  options: (wsId: number, table: string, column: string, q: string) =>
    api<FkOption[]>(`${base(wsId)}/data/${enc(table)}/options/${enc(column)}?q=${enc(q)}`),
  insert: (wsId: number, table: string, values: Record<string, WriteValue>) =>
    api<Row>(`${base(wsId)}/data/${enc(table)}`, { method: "POST", json: { values } }),
  update: (wsId: number, table: string, id: number, values: Record<string, WriteValue>) =>
    api<Row>(`${base(wsId)}/data/${enc(table)}/${id}`, { method: "PATCH", json: { values } }),
  remove: (wsId: number, table: string, id: number) =>
    api<void>(`${base(wsId)}/data/${enc(table)}/${id}`, { method: "DELETE" }),
  sqlWrite: (wsId: number, sql: string) =>
    api<SqlWriteOut>(`${base(wsId)}/query/write`, { method: "POST", json: { sql } }),
  changes: (wsId: number, limit = 50) => api<ChangesOut>(`${base(wsId)}/data-changes?limit=${limit}`),
}
