// Mirrors backend pydantic models (Task 3). Keep field names identical to the API.

export interface UserOut {
  id: number
  email: string
  display_name: string
}

export type WorkspaceStage = "empty" | "imported" | "analyzed" | "applied"

export interface WorkspaceOut {
  id: number
  name: string
  created_at: string
  stage: WorkspaceStage
  row_count: number | null
  column_count: number | null
  table_count: number | null
  query_count: number
  last_activity_at: string | null
}

export interface ApiErrorBody {
  error: { code: string; message: string; detail?: unknown }
}
