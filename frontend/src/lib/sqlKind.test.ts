import { describe, expect, test } from "vitest"
import { isWrite, statementInfo, writeSummary } from "./sqlKind"

const kind = (sql: string) => statementInfo(sql).kind

describe("statementInfo", () => {
  test("reads", () => {
    expect(kind("SELECT * FROM students")).toBe("select")
    expect(kind("  -- top payers\n select 1;")).toBe("select")
    expect(kind("(SELECT 1) UNION (SELECT 2)")).toBe("select")
    expect(kind("VALUES (1)")).toBe("select")
    expect(kind("WITH t AS (SELECT 1) SELECT * FROM t")).toBe("select")
  })

  test("writes, with their table", () => {
    expect(statementInfo("UPDATE fee_register SET fee_paid = 0 WHERE id = 1")).toEqual({
      kind: "update",
      table: "fee_register",
      hasWhere: true,
      keyword: "UPDATE",
    })
    expect(statementInfo("insert into Students (student_name) values ('a')")).toMatchObject({
      kind: "insert",
      table: "students",
    })
    expect(statementInfo('DELETE FROM ONLY ws_3."Fees" f USING x')).toMatchObject({ kind: "delete", table: "Fees" })
    expect(statementInfo("/* c */ DELETE FROM teachers;")).toMatchObject({ kind: "delete", hasWhere: false })
  })

  test("WHERE counts only at the statement's own level", () => {
    expect(statementInfo("UPDATE t SET a = (SELECT b FROM u WHERE u.id = 1)").hasWhere).toBe(false)
    expect(statementInfo("DELETE FROM t WHERE id IN (SELECT id FROM u)").hasWhere).toBe(true)
  })

  test("a WITH in front of a write is a write", () => {
    expect(statementInfo("WITH x AS (SELECT 1 AS id) DELETE FROM t WHERE id IN (SELECT id FROM x)")).toMatchObject({
      kind: "delete",
      table: "t",
    })
  })

  test("keywords inside strings and comments do not count", () => {
    expect(kind("SELECT 'DELETE FROM t' AS s")).toBe("select")
    expect(kind("-- DELETE FROM t\nSELECT 1")).toBe("select")
    expect(kind("SELECT $$UPDATE t$$")).toBe("select")
    expect(kind('SELECT "update" FROM t')).toBe("select")
  })

  test("other statements and nothing at all", () => {
    expect(statementInfo("TRUNCATE fee_register")).toMatchObject({ kind: "other", keyword: "TRUNCATE" })
    expect(kind("DROP TABLE x")).toBe("other")
    expect(kind("   ")).toBe("empty")
    expect(kind("-- just a comment")).toBe("empty")
    expect(kind(";")).toBe("empty")
  })
})

test("isWrite and writeSummary", () => {
  expect(["select", "insert", "update", "delete", "other"].map((k) => isWrite(k as never))).toEqual([
    false,
    true,
    true,
    true,
    false,
  ])
  expect(writeSummary(statementInfo("UPDATE fee_register SET fee_paid = 1"))).toBe(
    "This will UPDATE rows in fee_register.",
  )
  expect(writeSummary(statementInfo("INSERT INTO teachers VALUES (1)"))).toBe("This will INSERT rows into teachers.")
  expect(writeSummary(statementInfo("DELETE FROM students WHERE id = 3"))).toBe("This will DELETE rows from students.")
})
