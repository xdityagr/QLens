// Pure helpers for the step-through visualizer (features/query/StepThrough.tsx).

export type StageKind = "from" | "where" | "group_by" | "having" | "select" | "distinct" | "order_limit"

/** Mirrors backend/qlens/stepthrough/stages.py StageOut. */
export interface StageOut {
  kind: StageKind
  /** relational-algebra name and its clause, e.g. "Selection (WHERE)" */
  title: string
  /** σ, π, ⋈, ... */
  symbol: string
  caption: string
  /** the runnable SELECT for this stage */
  sql: string
  row_count: number
  columns: { name: string; type: string }[]
  /** at most 50 sample rows */
  rows: (string | number | boolean | null)[][]
  duration_ms: number
}

/** "Selection (WHERE)" -> "WHERE"; the clause the stage adds, for the rail. */
export function clauseOf(title: string): string {
  const m = /\(([^)]*)\)\s*$/.exec(title)
  return m ? m[1] : title
}

/** "Selection (WHERE)" -> "Selection". */
export function operationOf(title: string): string {
  return title.replace(/\s*\([^)]*\)\s*$/, "")
}

/** Grouping stages count groups; the rest count rows. */
export function unitOf(kind: StageKind, n: number): string {
  const word = kind === "group_by" || kind === "having" ? "group" : "row"
  return n === 1 ? word : `${word}s`
}

/**
 * Column names made unique for display: a join's `SELECT *` repeats names like `id`.
 * Later repeats get " (2)", " (3)", in order.
 */
export function uniqueColumnNames(names: string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((n) => {
    const k = (seen.get(n) ?? 0) + 1
    seen.set(n, k)
    return k === 1 ? n : `${n} (${k})`
  })
}

/**
 * Bar length (0..1) for a stage's row count against the largest stage. Square-root scale, so 3,000 against 5
 * still shows the 5; any non-zero count gets a visible sliver.
 */
export function barFraction(n: number, max: number): number {
  if (n <= 0 || max <= 0) return 0
  return Math.max(0.03, Math.min(1, Math.sqrt(n / max)))
}

const NUMERIC = /^(smallint|integer|bigint|numeric|real|double precision|money)\b/

export function isNumericType(type: string): boolean {
  return NUMERIC.test(type)
}

/** Next stage while auto-playing, or null at the end. */
export function nextStage(current: number, count: number): number | null {
  return current + 1 < count ? current + 1 : null
}

/**
 * Which lines of a stage's SQL are new compared with the previous stage (the backend prints one clause per
 * line). Lines are compared ignoring surrounding spaces; the first stage marks nothing.
 */
export function addedLines(prev: string | null, cur: string): boolean[] {
  const lines = cur.split("\n")
  if (prev === null) return lines.map(() => false)
  const before = new Set(prev.split("\n").map((l) => l.trim()))
  return lines.map((l) => l.trim() !== "" && !before.has(l.trim()))
}
