import type { AnalysisOut, FDOut } from "./types"

export interface HealthSummary {
  /** open things to look at: pending near-duplicate groups + accepted approximate dependencies */
  issues: number
  /** pending near-duplicate groups */
  duplicates: number
  /** rows that break an accepted approximate dependency */
  inconsistentRows: number
}

export function healthSummary(a: AnalysisOut): HealthSummary {
  const duplicates = a.duplicates.filter((d) => d.status === "pending").length
  // A rejected dependency won't feed the design, so its violations aren't a problem to fix.
  const approx = a.fds.filter((f) => !f.is_exact && f.accepted)
  const inconsistentRows = approx.reduce((n, f) => n + f.violating_rows, 0)
  return { issues: duplicates + approx.length, duplicates, inconsistentRows }
}

/** Dependencies grouped by determinant, in the order each determinant first appears. */
export function groupFdsByLhs(fds: FDOut[]): Array<{ lhs: string[]; fds: FDOut[] }> {
  const groups = new Map<string, { lhs: string[]; fds: FDOut[] }>()
  for (const f of fds) {
    // JSON keeps ["a_b"] and ["a", "b"] apart, which a plain join would not.
    const key = JSON.stringify(f.lhs)
    let g = groups.get(key)
    if (!g) {
      g = { lhs: f.lhs, fds: [] }
      groups.set(key, g)
    }
    g.fds.push(f)
  }
  return [...groups.values()]
}

// Backslash + "u": Python's escape prefix for characters above 0x7e (per UTF-16 unit, as Python does for astral characters).
const ESC = String.fromCharCode(92) + "u"

/**
 * Key the fix endpoint expects for a per-conflict override: the backend looks overrides up by
 * Python's json.dumps(lhs_values), which separates items with ", " and escapes non-ASCII.
 */
export function conflictKey(lhsValues: unknown[]): string {
  const ascii = (s: string) =>
    s
      .split("")
      .map((c) => (c.charCodeAt(0) > 0x7e ? ESC + c.charCodeAt(0).toString(16).padStart(4, "0") : c))
      .join("")
  return "[" + lhsValues.map((v) => ascii(JSON.stringify(v ?? null))).join(", ") + "]"
}
