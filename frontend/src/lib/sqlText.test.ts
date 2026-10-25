import { describe, expect, it } from "vitest"
import { locateError, tablesInSql } from "./sqlText"

describe("locateError", () => {
  it("turns a 1-based position into line, column and offset", () => {
    const sql = "SELECT name\nFROM studnts\nWHERE 1 = 1"
    // position of the "s" of "studnts": 12 chars on line 1 + newline, then "FROM " = 5
    const pos = sql.indexOf("studnts") + 1
    expect(locateError(sql, "syntax_error", pos)).toEqual({
      offset: sql.indexOf("studnts"),
      line: 2,
      column: 6,
      lineText: "FROM studnts",
    })
  })

  it("shifts database positions past leading whitespace the server trimmed", () => {
    const sql = "\n\n  SELECT nope FROM t"
    // the server ran "SELECT nope FROM t" and reported position 8 for "nope"
    const loc = locateError(sql, "db_error", 8)
    expect(loc?.offset).toBe(sql.indexOf("nope"))
    expect(loc?.line).toBe(3)
    expect(loc?.column).toBe(10)
  })

  it("does not shift validation positions, which count from the original text", () => {
    const sql = "  SELECT 1; SELECT 2"
    const loc = locateError(sql, "multiple_statements", sql.indexOf("SELECT 2") + 1)
    expect(loc?.offset).toBe(sql.indexOf("SELECT 2"))
  })

  it("returns null without a position and clamps past the end", () => {
    expect(locateError("SELECT 1", "timeout", null)).toBeNull()
    expect(locateError("SELECT 1", "db_error", undefined)).toBeNull()
    expect(locateError("SELECT", "syntax_error", 99)?.offset).toBe(6)
  })
})

describe("tablesInSql", () => {
  const names = ["students", "batches", "payments", "teachers"]

  it("finds tables after FROM and JOIN, in the order they appear", () => {
    const sql =
      "SELECT b.batch_name, count(*) FROM payments p JOIN students s ON s.student_id = p.student_id " +
      "JOIN batches b USING (batch_id) GROUP BY 1"
    expect(tablesInSql(sql, names)).toEqual(["payments", "students", "batches"])
  })

  it("handles comma joins, quoted and schema-qualified names, case", () => {
    expect(tablesInSql('select * from Students, "batches" b, ws_3.teachers where 1=1', names)).toEqual([
      "students",
      "batches",
      "teachers",
    ])
  })

  it("ignores names in strings, comments and column positions", () => {
    const sql = "SELECT students FROM payments -- join teachers\nWHERE note = 'from batches'"
    expect(tablesInSql(sql, names)).toEqual(["payments"])
  })

  it("finds tables inside subqueries", () => {
    expect(tablesInSql("SELECT * FROM (SELECT * FROM teachers) t", names)).toEqual(["teachers"])
  })
})
