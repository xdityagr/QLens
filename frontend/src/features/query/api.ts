import { api } from "../../lib/api"
import type { Cell } from "../../lib/types"

// Mirrors backend/qlens/query/routes.py and sandbox.py (Task 13).

export interface ResultColumn {
  name: string
  /** PostgreSQL type as format_type() prints it, e.g. "bigint", "numeric", "text" */
  type: string
}

export interface QueryResult {
  columns: ResultColumn[]
  rows: Cell[][]
  row_count: number
  /** more than 1000 rows matched; only the first 1000 came back */
  truncated: boolean
  duration_ms: number
}

export interface QueryRunOut {
  run_id: number
  result: QueryResult
}

export type QueryErrorCode =
  | "timeout"
  | "db_error"
  | "not_a_select"
  | "multiple_statements"
  | "forbidden_function"
  | "syntax_error"
  | "invalid_query"
  | "query_too_complex"
  // the SQL tab's write path (POST /query/write)
  | "not_a_write"
  | "one_write_only"
  | "write_target_not_allowed"

/** `detail` of a 400 from POST /query; validation errors carry only a position */
export interface QueryErrorDetail {
  sqlstate?: string | null
  position?: number | null
}

export interface SavedQueryOut {
  id: number
  title: string
  sql_text: string
  run_count: number
  last_run_at: string | null
  last_duration_ms: number | null
  created_at: string
  updated_at: string
}

export type RunSource = "typed" | "english" | "stepthrough" | "perf"
export type RunStatus = "ok" | "error" | "timeout"

export interface RunOut {
  id: number
  saved_query_id: number | null
  sql_text: string
  source: RunSource
  target: "main" | "lab"
  status: RunStatus
  duration_ms: number | null
  row_count: number | null
  error_message: string | null
  created_at: string
}

export interface TrendPoint {
  run_id: number
  run_number: number
  created_at: string
  duration_ms: number
  prev_ms: number | null
  moving_avg_ms: number | null
}

export interface SlowQuery {
  run_id: number
  sql_text: string
  duration_ms: number
  created_at: string
  /** the workspace's 90th-percentile duration over the last 30 days */
  p90_ms: number
}

/** A table as the query screen lists it: a designed table from GET /schema (SchemaOut), or one of the sheet's own. */
export interface QueryableColumn {
  name: string
  data_type: string
  not_null?: boolean
  is_pk?: boolean
  fk?: { table: string; column: string } | null
}

export interface QueryableTable {
  name: string
  /** lane colour; null for the sheet's own tables (_raw, _staging), which are not generated tables */
  color_index: number | null
  row_count: number | null
  columns: QueryableColumn[]
}

const ws = (id: number) => `/api/workspaces/${id}`

export const queryApi = {
  run: (wsId: number, sql: string, savedQueryId?: number | null) =>
    api<QueryRunOut>(`${ws(wsId)}/query`, {
      method: "POST",
      json: savedQueryId ? { sql, saved_query_id: savedQueryId } : { sql },
    }),
  savedList: (wsId: number) => api<SavedQueryOut[]>(`${ws(wsId)}/saved-queries`),
  save: (wsId: number, title: string, sql_text: string) =>
    api<SavedQueryOut>(`${ws(wsId)}/saved-queries`, { method: "POST", json: { title, sql_text } }),
  update: (wsId: number, sqId: number, patch: { title?: string; sql_text?: string }) =>
    api<SavedQueryOut>(`${ws(wsId)}/saved-queries/${sqId}`, { method: "PATCH", json: patch }),
  remove: (wsId: number, sqId: number) => api<void>(`${ws(wsId)}/saved-queries/${sqId}`, { method: "DELETE" }),
  trend: (wsId: number, sqId: number) => api<TrendPoint[]>(`${ws(wsId)}/saved-queries/${sqId}/trend`),
  history: (wsId: number, limit = 50) => api<RunOut[]>(`${ws(wsId)}/history?limit=${limit}`),
  slow: (wsId: number) => api<SlowQuery[]>(`${ws(wsId)}/slow-queries`),
}
