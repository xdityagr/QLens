import { describe, expect, it } from "vitest"
import type { WorkspaceOut } from "../../lib/types"
import { activityLine, dashboardStats, greeting, mostRecent, uniqueName } from "./dashboard"

function ws(p: Partial<WorkspaceOut> & { id: number }): WorkspaceOut {
  return {
    name: `ws ${p.id}`,
    created_at: "2026-10-01T10:00:00Z",
    stage: "empty",
    row_count: null,
    column_count: null,
    table_count: null,
    query_count: 0,
    last_activity_at: null,
    ...p,
  }
}

const list: WorkspaceOut[] = [
  ws({ id: 1, stage: "applied", row_count: 3000, column_count: 14, table_count: 4, query_count: 12, last_activity_at: "2026-10-24T09:00:00Z" }),
  ws({ id: 2, stage: "analyzed", row_count: 8412, column_count: 9, table_count: 0, query_count: 0, last_activity_at: "2026-10-25T08:00:00Z" }),
  ws({ id: 3, stage: "imported", row_count: 1260, column_count: 8, last_activity_at: null, created_at: "2026-10-20T10:00:00Z" }),
  ws({ id: 4, stage: "empty", created_at: "2026-10-25T09:30:00Z" }),
]

describe("dashboardStats", () => {
  it("sums only what exists: sheets are imported datasets, tables count only after apply", () => {
    expect(dashboardStats(list)).toEqual({ workspaces: 4, sheets: 3, rows: 12672, tables: 4, queries: 12 })
  })
  it("is all zeros for no workspaces", () => {
    expect(dashboardStats([])).toEqual({ workspaces: 0, sheets: 0, rows: 0, tables: 0, queries: 0 })
  })
})

describe("mostRecent", () => {
  it("picks the latest of last activity or creation", () => {
    expect(mostRecent(list)?.id).toBe(4)
    expect(mostRecent(list.slice(0, 3))?.id).toBe(2)
  })
  it("is null for an empty list", () => {
    expect(mostRecent([])).toBeNull()
  })
})

describe("activityLine", () => {
  it("describes each stage with its own numbers", () => {
    expect(activityLine(list[0])).toBe("Applied a design with 4 tables")
    expect(activityLine(list[1])).toBe("Analyzed 8,412 rows")
    expect(activityLine(list[2])).toBe("Imported 1,260 rows, 8 columns")
    expect(activityLine(list[3])).toBe("Created, no sheet yet")
  })
  it("uses singular words for one", () => {
    expect(activityLine(ws({ id: 9, stage: "applied", row_count: 1, table_count: 1 }))).toBe("Applied a design with 1 table")
  })
})

describe("uniqueName", () => {
  it("keeps a free name and numbers a taken one, case-insensitively", () => {
    expect(uniqueName("Kirana sales", ["Fees"])).toBe("Kirana sales")
    expect(uniqueName("Kirana sales", ["kirana SALES", "Kirana sales 2"])).toBe("Kirana sales 3")
  })
})

describe("greeting", () => {
  it("follows the local hour", () => {
    expect(greeting(new Date(2026, 9, 25, 7))).toBe("Good morning")
    expect(greeting(new Date(2026, 9, 25, 13))).toBe("Good afternoon")
    expect(greeting(new Date(2026, 9, 25, 19))).toBe("Good evening")
    expect(greeting(new Date(2026, 9, 25, 2))).toBe("Good evening")
  })
})
