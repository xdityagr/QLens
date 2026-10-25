import { groupFdsByLhs } from "./analysis"
import type { AnalysisOut, ColumnOut, InferredType } from "./types"

/**
 * The sheet's structure as a graph: columns are nodes, dependencies are edges from determinant to
 * dependent. A two-column determinant goes through a small join node so both columns visibly feed it.
 */

export type KeyRole = "primary" | "alternate"

export interface AnatomyColumn {
  name: string
  label: string
  type: InferredType | null
  distinct: number | null
  nulls: number | null
  /** part of the row identity (first candidate key) or only of another candidate key */
  keyRole: KeyRole | null
  /** lane of the group this column heads as a one-column determinant */
  lane: number | null
}

export interface AnatomyJoin {
  id: string
  lhs: string[]
  lane: number
}

export interface AnatomyEdge {
  id: string
  source: string
  target: string
  fdId: number
  /** lane of the determinant group, shared with the dependency list */
  lane: number
  /** join: a column feeding a two-column determinant's join node */
  kind: "exact" | "approx" | "join"
  accepted: boolean
  derived: boolean
  violatingRows: number
}

export interface Anatomy {
  /** columns that take part in at least one visible dependency, in sheet order */
  columns: AnatomyColumn[]
  joins: AnatomyJoin[]
  edges: AnatomyEdge[]
  /** columns no visible dependency touches, in sheet order */
  loose: AnatomyColumn[]
  primaryKey: string[] | null
  alternateKeys: string[][]
}

export const joinId = (lhs: string[]) => `join:${JSON.stringify(lhs)}`

export function buildAnatomy(a: AnalysisOut, cols: ColumnOut[], opts: { showDerived: boolean }): Anatomy {
  const [primaryKey = null, ...alternateKeys] = a.keys
  const keyRole = (n: string): KeyRole | null =>
    primaryKey?.includes(n) ? "primary" : alternateKeys.some((k) => k.includes(n)) ? "alternate" : null

  // Lanes come from all dependencies, so toggling derived ones never recolours a group.
  const groups = groupFdsByLhs(a.fds).map((g, lane) => ({ ...g, lane }))
  const laneOf = new Map<string, number>()
  for (const g of groups) if (g.lhs.length === 1) laneOf.set(g.lhs[0], g.lane)

  const edges: AnatomyEdge[] = []
  const joins: AnatomyJoin[] = []
  for (const g of groups) {
    const visible = g.fds.filter((f) => opts.showDerived || !f.is_derived)
    if (visible.length === 0) continue
    let from = g.lhs[0]
    if (g.lhs.length > 1) {
      from = joinId(g.lhs)
      joins.push({ id: from, lhs: g.lhs, lane: g.lane })
      for (const n of g.lhs)
        edges.push({
          id: `${from}<-${n}`,
          source: n,
          target: from,
          fdId: visible[0].id,
          lane: g.lane,
          kind: "join",
          accepted: visible.some((f) => f.accepted),
          derived: visible.every((f) => f.is_derived),
          violatingRows: 0,
        })
    }
    for (const f of visible)
      edges.push({
        // by content, not fd id: re-analysis after a cleanup issues new ids for the same rules
        id: `${JSON.stringify(g.lhs)}->${f.rhs}`,
        source: from,
        target: f.rhs,
        fdId: f.id,
        lane: g.lane,
        kind: f.is_exact ? "exact" : "approx",
        accepted: f.accepted,
        derived: f.is_derived,
        violatingRows: f.violating_rows,
      })
  }

  // Sheet order from the profile; without it, the order names first appear in keys and rules.
  const names = cols.length
    ? [...cols].sort((x, y) => x.ordinal - y.ordinal).map((c) => c.name)
    : [...new Set([...a.keys.flat(), ...a.fds.flatMap((f) => [...f.lhs, f.rhs])])]
  const byName = new Map(cols.map((c) => [c.name, c]))
  const touched = new Set(edges.flatMap((e) => [e.source, e.target]))
  const all: AnatomyColumn[] = names.map((n) => {
    const c = byName.get(n)
    return {
      name: n,
      label: c?.label ?? n,
      type: c?.inferred_type ?? null,
      distinct: c?.distinct_count ?? null,
      nulls: c?.null_count ?? null,
      keyRole: keyRole(n),
      lane: laneOf.get(n) ?? null,
    }
  })
  return {
    columns: all.filter((c) => touched.has(c.name)),
    joins,
    edges,
    loose: all.filter((c) => !touched.has(c.name)),
    primaryKey,
    alternateKeys,
  }
}
