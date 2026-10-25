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
