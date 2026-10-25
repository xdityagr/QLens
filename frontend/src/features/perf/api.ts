import { api } from "../../lib/api"
import type { PlanOut } from "../../lib/plan"

// Mirrors backend/qlens/perf/{routes,lab,advisor}.py (Task 15).

export interface LabIndex {
  name: string
  columns: string[]
}

export interface LabTable {
  name: string
  color_index: number
  row_count: number
  indexes: LabIndex[]
}

/** the lab schema now; no tables (and factor 1) before it is built */
export interface LabOut {
  tables: LabTable[]
  /** how many times the fact table has been multiplied so far */
  scale_factor: number
}

export interface IndexSuggestion {
  table: string
  columns: string[]
  /** why, in plain words, with the row counts from the plan */
  reason: string
  ddl: string
}

export interface ExplainOut {
  run_id: number
  plan: PlanOut
  suggestions: IndexSuggestion[]
}

export interface ExperimentRow {
  id: number
  table: string
  columns: string[]
  index_name: string
  ddl: string
  /** median of the timed runs, before and after the index */
  before_ms: number
  after_ms: number
  /** before / after; null when after was 0 */
  speedup: number | null
  runs: number
  /** kept = the index is in the lab; dropped = removed (or the lab was rebuilt) */
  status: "kept" | "dropped" | string
  created_at: string
}

export interface ExperimentOut extends ExperimentRow {
  before_plan: PlanOut
  after_plan: PlanOut
}

const ws = (wsId: number) => `/api/workspaces/${wsId}`

export const perfApi = {
  lab: (wsId: number) => api<LabOut>(`${ws(wsId)}/lab`),
  build: (wsId: number) => api<LabOut>(`${ws(wsId)}/lab`, { method: "POST" }),
  reset: (wsId: number) => api<LabOut>(`${ws(wsId)}/lab/reset`, { method: "POST" }),
  scale: (wsId: number, factor: number) => api<LabOut>(`${ws(wsId)}/lab/scale`, { method: "POST", json: { factor } }),
  /** EXPLAIN ANALYZE: runs the query once (read-only) and returns its plan and the advisor's index suggestions */
  explain: (wsId: number, sql: string, target: "main" | "lab" = "main") =>
    api<ExplainOut>(`${ws(wsId)}/explain`, { method: "POST", json: { sql, target } }),
  tryIndex: (wsId: number, sql: string, table: string, columns: string[]) =>
    api<ExperimentOut>(`${ws(wsId)}/lab/try-index`, { method: "POST", json: { sql, table, columns } }),
  experiments: (wsId: number) => api<ExperimentRow[]>(`${ws(wsId)}/lab/experiments`),
  drop: (wsId: number, expId: number) =>
    api<ExperimentRow>(`${ws(wsId)}/lab/experiments/${expId}`, { method: "DELETE" }),
}
