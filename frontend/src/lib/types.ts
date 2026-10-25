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

// ---- design (Tasks 10/11) ---------------------------------------------------

export type ColumnRole = "pk" | "fk" | "attribute"
export type ProposalStatus = "draft" | "applied" | "superseded"

export interface ProposedColumnOut {
  id: number
  name: string
  data_type: string
  role: ColumnRole
  not_null: boolean
  references_table_id: number | null
  /** the sheet column an attribute holds; null for ids and foreign keys */
  source_column: string | null
  /** the sheet header behind the column (for a foreign key, that of the natural key it stands for) */
  source_label: string | null
}

export interface TableOut {
  id: number
  name: string
  kind: "entity" | "fact"
  color_index: number
  explanation: string
  columns: ProposedColumnOut[]
  /** column names; for an entity the first key is its natural key */
  unique_keys: string[][]
}

export interface ProposalOut {
  id: number
  status: ProposalStatus
  lossless_ok: boolean | null
  source_columns: string[]
  tables: TableOut[]
}

export interface AppliedTable {
  name: string
  row_count: number
  color_index: number
}

export interface ApplyOut {
  ok: boolean
  lossless_ok: boolean
  staging_rows: number
  reconstructed_rows: number
  mismatch_rows: number
  tables: AppliedTable[]
  duration_ms: number
  sql: string
}

/** detail of a 409 lossless_check_failed */
export interface LosslessFailure {
  mismatch_rows: number
  extra_rows?: number
  missing_rows?: number
  sample: { side: "missing" | "extra"; row: Record<string, Cell> }[]
}

export interface SchemaColumn {
  name: string
  data_type: string
  not_null: boolean
  is_pk: boolean
  fk: { table: string; column: string } | null
}

export interface SchemaTable {
  name: string
  color_index: number
  row_count: number
  columns: SchemaColumn[]
  indexes: { name: string; columns: string[]; unique: boolean }[]
}

export interface SchemaOut {
  tables: SchemaTable[]
}
