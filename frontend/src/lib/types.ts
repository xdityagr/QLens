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

// ---- dataset (Task 5) ---------------------------------------------------------

export type InferredType = "integer" | "numeric" | "boolean" | "date" | "text"
export type DatasetStatus = "imported" | "analyzed" | "applied"
export type SampleName = "fee_register" | "kirana_sales" | "hostel_mess"

export interface ColumnOut {
  id: number
  ordinal: number
  /** SQL identifier QLens gave the column */
  name: string
  /** header exactly as it was in the sheet */
  label: string
  inferred_type: InferredType
  null_count: number
  distinct_count: number
  sample_values: string[]
}

export interface DatasetOut {
  id: number
  original_filename: string
  source: "upload" | "sample"
  row_count: number
  column_count: number
  status: DatasetStatus
  columns: ColumnOut[]
}

/** Cell values as JSON: numerics and dates arrive as strings. */
export type Cell = string | number | boolean | null

export interface DatasetDetailOut extends DatasetOut {
  preview: { columns: string[]; rows: Cell[][] }
}

// ---- analysis (Tasks 7 and 8) ---------------------------------------------------

export interface FDOut {
  id: number
  lhs: string[]
  rhs: string
  is_exact: boolean
  violating_rows: number
  violation_ratio: number
  accepted: boolean
  /** implied by the minimal cover of the other exact accepted FDs */
  is_derived: boolean
  sentence: string
}

export interface ValueCount {
  value: string
  rows: number
}

export interface DuplicateGroupOut {
  id: number
  column: string
  canonical_value: string
  confidence: "same_normalized" | "similar"
  /** pg_trgm similarity of the closest pair; null when every member normalizes equal */
  max_similarity: number | null
  status: "pending" | "merged" | "dismissed"
  values: ValueCount[]
}

export interface VariantOut {
  value: string | null
  rows: number
}

export interface ConflictOut {
  /** determinant values as text (NULL stays null) */
  lhs_values: (string | null)[]
  variants: VariantOut[]
  suggested: string | null
}

export interface InconsistencyOut {
  fd_id: number
  sentence: string
  lhs: string[]
  rhs: string
  conflicts: ConflictOut[]
}

export interface AnalysisOut {
  dataset_id: number
  row_count: number
  keys: string[][]
  fds: FDOut[]
  duplicates: DuplicateGroupOut[]
  inconsistencies: InconsistencyOut[]
}
