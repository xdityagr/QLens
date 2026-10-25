import { describe, expect, it } from "vitest"
import {
  addedLines,
  barFraction,
  clauseOf,
  isNumericType,
  nextStage,
  operationOf,
  uniqueColumnNames,
  unitOf,
} from "./stepthrough"

describe("stage titles", () => {
  it("splits the operation from its clause", () => {
    expect(clauseOf("Selection (WHERE)")).toBe("WHERE")
    expect(operationOf("Selection (WHERE)")).toBe("Selection")
    expect(clauseOf("Sort and limit (ORDER BY … LIMIT)")).toBe("ORDER BY … LIMIT")
    expect(operationOf("Selection on groups (HAVING)")).toBe("Selection on groups")
    expect(clauseOf("Projection")).toBe("Projection")
  })

  it("counts groups for grouping stages and rows otherwise", () => {
    expect(unitOf("group_by", 8)).toBe("groups")
    expect(unitOf("having", 1)).toBe("group")
    expect(unitOf("where", 1)).toBe("row")
    expect(unitOf("from", 3000)).toBe("rows")
  })
})

describe("uniqueColumnNames", () => {
  it("numbers repeated names from a join's SELECT *", () => {
    expect(uniqueColumnNames(["id", "name", "id", "batch_id", "id"])).toEqual([
      "id",
      "name",
      "id (2)",
      "batch_id",
      "id (3)",
    ])
  })
  it("leaves distinct names alone", () => {
    expect(uniqueColumnNames(["a", "b"])).toEqual(["a", "b"])
  })
})

describe("barFraction", () => {
  it("is a square-root share of the largest stage", () => {
    expect(barFraction(3000, 3000)).toBe(1)
    expect(barFraction(750, 3000)).toBeCloseTo(0.5)
  })
  it("keeps tiny counts visible and zero empty", () => {
    expect(barFraction(1, 1_000_000)).toBe(0.03)
    expect(barFraction(0, 3000)).toBe(0)
    expect(barFraction(5, 0)).toBe(0)
  })
})

describe("misc", () => {
  it("recognises numeric column types", () => {
    expect(isNumericType("bigint")).toBe(true)
    expect(isNumericType("numeric(10,2)")).toBe(true)
    expect(isNumericType("text")).toBe(false)
  })
  it("auto-play stops at the last stage", () => {
    expect(nextStage(0, 3)).toBe(1)
    expect(nextStage(2, 3)).toBeNull()
  })
})

describe("addedLines", () => {
  it("marks the clause a stage adds", () => {
    const from = "SELECT *\nFROM fee_register AS f"
    expect(addedLines(from, from + "\nWHERE f.fee_paid = 0")).toEqual([false, false, true])
  })
  it("marks a changed select list but not the shared FROM", () => {
    expect(
      addedLines(
        "SELECT b.batch, count(*) AS rows_in_group\nFROM t\nGROUP BY b.batch",
        "SELECT b.batch, count(*) AS unpaid\nFROM t\nGROUP BY b.batch",
      ),
    ).toEqual([true, false, false])
  })
  it("marks nothing on the first stage", () => {
    expect(addedLines(null, "SELECT *\nFROM t")).toEqual([false, false])
  })
})
