import { fmtInt } from "../../lib/format"
import type { WorkspaceOut } from "../../lib/types"

export interface DashboardStats {
  workspaces: number
  sheets: number
  rows: number
  tables: number
  queries: number
}

/** Totals for the stats row. Tables only count once a design is applied (before that the count is 0 or null). */
export function dashboardStats(list: WorkspaceOut[]): DashboardStats {
  const s: DashboardStats = { workspaces: list.length, sheets: 0, rows: 0, tables: 0, queries: 0 }
  for (const w of list) {
    if (w.row_count !== null) {
      s.sheets += 1
      s.rows += w.row_count
    }
    if (w.stage === "applied") s.tables += w.table_count ?? 0
    s.queries += w.query_count
  }
  return s
}

/** When the user last touched a workspace; a new one counts from its creation. */
export function touchedAt(w: WorkspaceOut): number {
  return new Date(w.last_activity_at ?? w.created_at).getTime()
}

export function mostRecent(list: WorkspaceOut[]): WorkspaceOut | null {
  let best: WorkspaceOut | null = null
  for (const w of list) if (!best || touchedAt(w) > touchedAt(best)) best = w
  return best
}

const plural = (n: number, one: string, many: string) => `${fmtInt(n)} ${n === 1 ? one : many}`

/** One plain sentence for the activity list, from the fields the list endpoint already returns. */
export function activityLine(w: WorkspaceOut): string {
  switch (w.stage) {
    case "applied":
      return `Applied a design with ${plural(w.table_count ?? 0, "table", "tables")}`
    case "analyzed":
      return `Analyzed ${plural(w.row_count ?? 0, "row", "rows")}`
    case "imported":
      return `Imported ${plural(w.row_count ?? 0, "row", "rows")}, ${plural(w.column_count ?? 0, "column", "columns")}`
    default:
      return "Created, no sheet yet"
  }
}

/** Workspace names are unique per user (case-insensitive), so number a sample's copy. */
export function uniqueName(base: string, taken: string[]): string {
  const used = new Set(taken.map((t) => t.trim().toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}

export function greeting(now: Date = new Date()): string {
  const h = now.getHours()
  if (h >= 5 && h < 12) return "Good morning"
  if (h >= 12 && h < 17) return "Good afternoon"
  return "Good evening"
}
