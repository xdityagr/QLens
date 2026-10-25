import { ApiError } from "../../lib/api"
import type { ColumnOut } from "../../lib/types"

/** name -> column, for showing a sheet header next to the SQL identifier. */
export type ColumnIndex = Map<string, ColumnOut>

export function indexColumns(cols: ColumnOut[] | undefined): ColumnIndex {
  return new Map((cols ?? []).map((c) => [c.name, c]))
}

export function isMockGap(e: unknown) {
  return e instanceof ApiError && e.code === "mock_not_implemented"
}

// Keys use the yellow lane, like an ERD's key glyph; the accent blue already means lane 0.
export const KEY_COLOR = "var(--lane-6)"

/** DOM ids the diagram scrolls to: an inconsistency in Issues, a rule in the rules list. */
export const issueId = (fdId: number) => `issue-fd-${fdId}`
export const ruleId = (fdId: number) => `rule-fd-${fdId}`
