import { describe, expect, test } from "vitest"
import { describeFilter, formatFilter, opsFor, parseFilter } from "./rowFilters"

const col = (data_type: string, fk: { table: string; column: string } | null = null) => ({
  name: "c",
  data_type,
  not_null: false,
  is_pk: false,
  fk,
})

describe("formatFilter / parseFilter", () => {
  test("round-trip the API's column:op:value form", () => {
    expect(formatFilter({ column: "fee_paid", op: "gt", value: "3000" })).toBe("fee_paid:gt:3000")
    expect(formatFilter({ column: "payment_mode", op: "empty", value: "" })).toBe("payment_mode:empty")
    expect(parseFilter("fee_paid:gt:3000")).toEqual({ column: "fee_paid", op: "gt", value: "3000" })
    expect(parseFilter("payment_mode:empty")).toEqual({ column: "payment_mode", op: "empty", value: "" })
  })
  test("a value keeps its colons", () => {
    expect(parseFilter("note:contains:a:b")).toEqual({ column: "note", op: "contains", value: "a:b" })
  })
  test("anything malformed is dropped", () => {
    expect(parseFilter("x")).toBeNull()
    expect(parseFilter("x:like:1")).toBeNull()
    expect(parseFilter("x:eq")).toBeNull()
  })
})

describe("opsFor", () => {
  test("offers what makes sense for the column", () => {
    expect(opsFor(col("text"))).toEqual(["contains", "eq", "empty"])
    expect(opsFor(col("bigint"))).toEqual(["eq", "gt", "lt", "empty"])
    expect(opsFor(col("date"))).toEqual(["eq", "gt", "lt", "empty"])
    expect(opsFor(col("boolean"))).toEqual(["eq", "empty"])
    expect(opsFor(col("bigint", { table: "students", column: "id" }))).toEqual(["contains", "eq", "empty"])
  })
})

describe("describeFilter", () => {
  test("reads like the condition", () => {
    expect(describeFilter({ column: "fee_paid", op: "gt", value: "3000" })).toBe("fee_paid > 3000")
    expect(describeFilter({ column: "student_name", op: "contains", value: "riya" })).toBe(
      "student_name contains “riya”",
    )
    expect(describeFilter({ column: "payment_mode", op: "empty", value: "" })).toBe("payment_mode is empty")
    expect(describeFilter({ column: "id", op: "eq", value: "7" })).toBe("id = 7")
  })
})
