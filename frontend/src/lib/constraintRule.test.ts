import { expect, test } from "vitest"
import { constraintRule } from "./constraintRule"

const d = (over: Record<string, unknown>) => ({
  kind: "other",
  constraint: null,
  columns: [],
  table: "students",
  ...over,
})

test("names the rule kind and the constraint PostgreSQL enforced", () => {
  expect(constraintRule(d({ kind: "foreign_key", constraint: "fee_register_student_id_fkey" }))).toEqual({
    rule: "FOREIGN KEY",
    name: "fee_register_student_id_fkey",
  })
  expect(constraintRule(d({ kind: "unique", constraint: "students_student_name_key" }))).toEqual({
    rule: "UNIQUE",
    name: "students_student_name_key",
  })
  expect(constraintRule(d({ kind: "check", constraint: "fee_paid_not_negative" })).rule).toBe("CHECK")
})

test("rules without a named constraint fall back to table.column", () => {
  expect(constraintRule(d({ kind: "not_null", columns: ["student_name"] }))).toEqual({
    rule: "NOT NULL",
    name: "students.student_name",
  })
  expect(constraintRule(d({ kind: "invalid_input", columns: ["fee_paid"], table: "fee_register" }))).toEqual({
    rule: "TYPE",
    name: "fee_register.fee_paid",
  })
  expect(constraintRule(d({ kind: "other" }))).toEqual({ rule: "CONSTRAINT", name: "students" })
})
