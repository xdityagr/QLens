// What changed between two versions of a design, so the canvas can glide, flash, place in and fade out
// the right tables. An assistant edit makes a new draft version, which copies every table under a new id;
// tables are therefore paired by what they hold (the sheet columns), not only by id or name.

import { nodeId } from "./graphLayout"
import type { ProposedColumnOut, TableOut } from "./types"

export type DesignChange =
  | { kind: "rename-table"; from: string; to: string }
  | { kind: "rename-column"; table: string; from: string; to: string }
  | { kind: "columns"; table: string }
  | { kind: "add-table"; name: string }
  | { kind: "remove-table"; name: string }

export interface DesignDiff {
  changes: DesignChange[]
  /** next-version ids of tables that are still there but changed (renamed or different columns) */
  changedIds: Set<number>
  /** next-version ids of tables with no counterpart before */
  addedIds: Set<number>
  /** previous-version ids of tables that are gone */
  removedIds: Set<number>
}

const signature = (t: TableOut) =>
  t.columns
    .filter((c) => c.role === "attribute" && c.source_column)
    .map((c) => c.source_column)
    .sort()
    .join("|")

/**
 * Pairs each next table with a previous one: same id, else same name, else the same sheet columns
 * (a renamed table in a new version). Returns next id -> previous id; new tables are absent.
 */
export function matchTables(prev: TableOut[], next: TableOut[]): Map<number, number> {
  const out = new Map<number, number>()
  const claimed = new Set<number>()
  const pass = (key: (t: TableOut) => string | number) => {
    const byKey = new Map<string | number, TableOut>()
    for (const p of prev) if (!claimed.has(p.id) && !byKey.has(key(p))) byKey.set(key(p), p)
    for (const n of next) {
      if (out.has(n.id)) continue
      const k = key(n)
      if (k === "") continue
      const p = byKey.get(k)
      if (p && !claimed.has(p.id)) {
        out.set(n.id, p.id)
        claimed.add(p.id)
        byKey.delete(k)
      }
    }
  }
  pass((t) => t.id)
  pass((t) => t.name)
  pass((t) => (signature(t) ? `${t.kind}:${signature(t)}` : ""))
  return out
}

function matchColumns(prev: ProposedColumnOut[], next: ProposedColumnOut[], tableMatch: Map<number, number>) {
  const out = new Map<ProposedColumnOut, ProposedColumnOut>()
  const left = new Set(prev)
  const pass = (key: (c: ProposedColumnOut, side: "p" | "n") => string | null) => {
    for (const n of next) {
      if (out.has(n)) continue
      const k = key(n, "n")
      if (k === null) continue
      const p = [...left].find((c) => key(c, "p") === k)
      if (p) {
        out.set(n, p)
        left.delete(p)
      }
    }
  }
  pass((c) => `id:${c.id}`)
  pass((c) => (c.source_column ? `src:${c.source_column}` : null))
  pass((c) => (c.role === "pk" ? "pk" : null))
  // a foreign key is the same one when it points at the same (paired) table
  pass((c, side) => {
    if (c.role !== "fk" || c.references_table_id === null) return null
    const ref = side === "n" ? (tableMatch.get(c.references_table_id) ?? -1) : c.references_table_id
    return `fk:${ref}`
  })
  pass((c) => `name:${c.name}`)
  return { pairs: out, unmatchedPrev: left.size, unmatchedNext: next.length - out.size }
}

export function diffProposals(prev: TableOut[], next: TableOut[]): DesignDiff {
  const match = matchTables(prev, next)
  const prevById = new Map(prev.map((t) => [t.id, t]))
  const changes: DesignChange[] = []
  const changedIds = new Set<number>()
  const addedIds = new Set<number>()
  for (const n of next) {
    const pid = match.get(n.id)
    const p = pid === undefined ? undefined : prevById.get(pid)
    if (!p) {
      changes.push({ kind: "add-table", name: n.name })
      addedIds.add(n.id)
      continue
    }
    if (p.name !== n.name) {
      changes.push({ kind: "rename-table", from: p.name, to: n.name })
      changedIds.add(n.id)
    }
    const cols = matchColumns(p.columns, n.columns, match)
    for (const [nc, pc] of cols.pairs)
      if (nc.name !== pc.name) {
        changes.push({ kind: "rename-column", table: n.name, from: pc.name, to: nc.name })
        changedIds.add(n.id)
      }
    if (cols.unmatchedPrev || cols.unmatchedNext) {
      changes.push({ kind: "columns", table: n.name })
      changedIds.add(n.id)
    }
  }
  const kept = new Set(match.values())
  const removedIds = new Set<number>()
  for (const p of prev)
    if (!kept.has(p.id)) {
      changes.push({ kind: "remove-table", name: p.name })
      removedIds.add(p.id)
    }
  return { changes, changedIds, addedIds, removedIds }
}

/**
 * The React Flow node id for each next table: a table keeps the id it was shown under (so it glides
 * instead of popping out and back in); new tables get their own. `shown` maps previous table id -> node id.
 */
export function stableIds(prev: TableOut[], shown: Map<number, string>, next: TableOut[]): Map<number, string> {
  const match = matchTables(prev, next)
  const out = new Map<number, string>()
  const used = new Set<string>()
  for (const n of next) {
    const pid = match.get(n.id)
    const id = pid !== undefined ? shown.get(pid) : undefined
    if (id && !used.has(id)) {
      out.set(n.id, id)
      used.add(id)
    }
  }
  for (const n of next) {
    if (out.has(n.id)) continue
    let id = nodeId(n.id)
    while (used.has(id)) id += "'"
    out.set(n.id, id)
    used.add(id)
  }
  return out
}
