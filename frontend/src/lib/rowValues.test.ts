import { describe, expect, test } from "vitest"
import { buildValues, coerce, diffRow, inputKind, toInput } from "./rowValues"

const col = (
  name: string,
  data_type: string,
  extra: Partial<{ not_null: boolean; is_pk: boolean; fk: { table: string; column: string } | null }> = {},
) => ({
  name,
  data_type,
  not_null: false,
  is_pk: false,
  fk: null,
  ...extra,
})

const students = [
  col("id", "bigint", { is_pk: true, not_null: true }),
  col("student_name", "text", { not_null: true }),
  col("student_phone", "text"),
  col("batch_id", "bigint", { not_null: true, fk: { table: "batches", column: "id" } }),
]

describe("inputKind", () => {
  test("maps PostgreSQL types to the input to show", () => {
    expect(inputKind("bigint")).toBe("integer")
    expect(inputKind("smallint")).toBe("integer")
    expect(inputKind("numeric")).toBe("decimal")
    expect(inputKind("numeric(10,2)")).toBe("decimal")
    expect(inputKind("double precision")).toBe("decimal")
    expect(inputKind("boolean")).toBe("boolean")
    expect(inputKind("date")).toBe("date")
    expect(inputKind("timestamp with time zone")).toBe("text")
    expect(inputKind("text")).toBe("text")
    expect(inputKind("character varying(20)")).toBe("text")
  })
})

describe("toInput", () => {
  test("turns a cell into what an input holds", () => {
    expect(toInput(null)).toBe("")
    expect(toInput(undefined)).toBe("")
    expect(toInput(true)).toBe("true")
    expect(toInput(42)).toBe("42")
    expect(toInput("1500.50")).toBe("1500.50")
  })
})

describe("coerce", () => {
  test("blank means NULL, whatever the type", () => {
    expect(coerce("", col("a", "text"))).toBeNull()
    expect(coerce("   ", col("a", "bigint"))).toBeNull()
    expect(coerce("", col("a", "boolean"))).toBeNull()
  })
  test("text is trimmed but otherwise sent as typed", () => {
    expect(coerce("  Riya Sharma ", col("a", "text"))).toBe("Riya Sharma")
  })
  test("numbers go as text so PostgreSQL parses them (and rejects what is not a number)", () => {
    expect(coerce(" 1500 ", col("a", "bigint"))).toBe("1500")
    expect(coerce("12.50", col("a", "numeric"))).toBe("12.50")
    expect(coerce("lots", col("a", "bigint"))).toBe("lots")
  })
  test("booleans become true/false", () => {
    expect(coerce("true", col("a", "boolean"))).toBe(true)
    expect(coerce("false", col("a", "boolean"))).toBe(false)
  })
  test("a foreign key is the referenced id as a number when it is one", () => {
    expect(coerce("7", students[3])).toBe(7)
    expect(coerce("x7", students[3])).toBe("x7")
  })
})

describe("buildValues", () => {
  test("a new row sends every column but the id, blanks as NULL", () => {
    const form = { id: "99", student_name: "Zoya", student_phone: "", batch_id: "3" }
    expect(buildValues(students, form)).toEqual({ student_name: "Zoya", student_phone: null, batch_id: 3 })
  })
  test("an edit sends only what changed", () => {
    const row = { id: 5, student_name: "Riya Sharma", student_phone: "98100", batch_id: 2 }
    const form = { id: "5", student_name: "Riya Sharma", student_phone: "98111", batch_id: "2" }
    expect(buildValues(students, form, row)).toEqual({ student_phone: "98111" })
  })
  test("clearing a value is a change to NULL; untouched NULLs are not", () => {
    const row = { id: 5, student_name: "Riya", student_phone: null, batch_id: 2 }
    expect(buildValues(students, { student_name: "", student_phone: "", batch_id: "2" }, row)).toEqual({
      student_name: null,
    })
  })
  test("whitespace-only edits are not changes", () => {
    const row = { id: 5, student_name: "Riya", student_phone: null, batch_id: 2 }
    expect(buildValues(students, { student_name: " Riya ", student_phone: "", batch_id: "2" }, row)).toEqual({})
  })
})

describe("diffRow", () => {
  test("an update lists every column with what changed marked, id left out", () => {
    const before = { id: 5, student_name: "Riya", student_phone: "98100", batch_id: 2 }
    const after = { id: 5, student_name: "Riya", student_phone: "98111", batch_id: 2 }
    expect(diffRow(before, after)).toEqual([
      { column: "student_name", before: "Riya", after: "Riya", changed: false },
      { column: "student_phone", before: "98100", after: "98111", changed: true },
      { column: "batch_id", before: 2, after: 2, changed: false },
    ])
  })
  test("an insert has only after values, a delete only before values", () => {
    expect(diffRow(null, { id: 1, a: "x" })).toEqual([{ column: "a", before: undefined, after: "x", changed: true }])
    expect(diffRow({ id: 1, a: "x" }, null)).toEqual([{ column: "a", before: "x", after: undefined, changed: true }])
  })
  test("values are compared by content, so equal numbers and NULLs are unchanged", () => {
    expect(diffRow({ id: 1, a: null, b: 1 }, { id: 1, a: null, b: 1 }).filter((d) => d.changed)).toEqual([])
    expect(diffRow({ id: 1, a: null }, { id: 1, a: "" })[0].changed).toBe(true)
  })
  test("columns only one side has still show", () => {
    expect(diffRow({ id: 1, a: 1 }, { id: 1, b: 2 }).map((d) => d.column)).toEqual(["b", "a"])
  })
})
