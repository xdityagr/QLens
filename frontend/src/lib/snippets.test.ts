import { describe, expect, test } from "vitest"
import { starterQuestions, starterSnippets, type SnippetTable } from "./snippets"

const pk = { name: "id", data_type: "bigint", is_pk: true, fk: null }
const col = (name: string, data_type = "text") => ({ name, data_type, is_pk: false, fk: null })
const fk = (name: string, table: string) => ({ name, data_type: "bigint", is_pk: false, fk: { table, column: "id" } })
const uniq = (...columns: string[]) => ({ name: columns.join("_") + "_key", columns, unique: true })

// The fee_register sample as Design applies it.
const FEES: SnippetTable[] = [
  {
    name: "students",
    row_count: 300,
    columns: [pk, col("student_name"), col("student_phone"), fk("batch_id", "batches")],
    indexes: [uniq("student_name")],
  },
  {
    name: "batches",
    row_count: 8,
    columns: [pk, col("batch"), fk("teacher_id", "teachers")],
    indexes: [uniq("batch")],
  },
  { name: "teachers", row_count: 6, columns: [pk, col("teacher"), col("teacher_phone")], indexes: [uniq("teacher")] },
  {
    name: "fee_register",
    row_count: 3000,
    columns: [pk, fk("student_id", "students"), col("month"), col("fee_paid", "numeric"), col("payment_mode")],
    indexes: [uniq("student_id", "month")],
  },
]

const byTitle = (title: string) => {
  const s = starterSnippets(FEES).find((x) => x.title === title)
  if (!s) throw new Error(`no snippet "${title}" in ${starterSnippets(FEES).map((x) => x.title)}`)
  return s
}

describe("starterSnippets for fee_register", () => {
  test("reads come first, examples that change data last", () => {
    const all = starterSnippets(FEES)
    expect(all.map((s) => s.title)).toEqual([
      "fee_register with its students",
      "Total fee_paid per batch",
      "Top 10 students by fee_paid",
      "students with fee_paid = 0 in the most recent month",
      "students with no fee_register rows",
      "Add 100 to fee_paid of one fee_register row",
      "Try to delete a student that fee_register uses",
    ])
    expect(all.map((s) => s.changesData)).toEqual([false, false, false, false, false, true, true])
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length)
  })

  test("joins follow the foreign keys, by natural-key labels", () => {
    expect(byTitle("fee_register with its students").sql).toBe(
      "SELECT f.*, s.student_name\nFROM fee_register f\nJOIN students s ON s.id = f.student_id\nLIMIT 50;",
    )
    // a table two foreign keys away is reached through the one in between
    expect(byTitle("Total fee_paid per batch").sql).toBe(
      [
        "SELECT b.batch, count(*) AS fee_register_rows, sum(f.fee_paid) AS total_fee_paid",
        "FROM fee_register f",
        "JOIN students s ON s.id = f.student_id",
        "JOIN batches b ON b.id = s.batch_id",
        "GROUP BY b.batch",
        "ORDER BY total_fee_paid DESC;",
      ].join("\n"),
    )
  })

  test("the period filter uses the most recent value, and the anti-join uses NOT EXISTS", () => {
    // month is text ("Apr", "Sep"): max() would sort it alphabetically, so the newest row's month is used
    expect(byTitle("students with fee_paid = 0 in the most recent month").sql).toContain(
      "WHERE f.fee_paid = 0\n  AND f.month = (SELECT month FROM fee_register ORDER BY id DESC LIMIT 1)",
    )
    // a real date sorts by time, so max() is right
    const dated = FEES.map((x) =>
      x.name === "fee_register"
        ? {
            ...x,
            columns: x.columns.map((c) => (c.name === "month" ? { ...c, name: "paid_on", data_type: "date" } : c)),
          }
        : x,
    )
    expect(starterSnippets(dated).find((s) => s.id === "zero-latest")!.sql).toContain(
      "AND f.paid_on = (SELECT max(paid_on) FROM fee_register)",
    )
    expect(byTitle("students with no fee_register rows").sql).toBe(
      "SELECT s.*\nFROM students s\nWHERE NOT EXISTS (SELECT 1 FROM fee_register f WHERE f.student_id = s.id);",
    )
  })

  test("the refused delete targets a row that is certainly referenced", () => {
    expect(byTitle("Try to delete a student that fee_register uses").sql).toBe(
      "DELETE FROM students\nWHERE id = (SELECT min(student_id) FROM fee_register);",
    )
    expect(byTitle("Add 100 to fee_paid of one fee_register row").sql).toBe(
      "UPDATE fee_register\nSET fee_paid = fee_paid + 100\nWHERE id = (SELECT min(id) FROM fee_register);",
    )
  })
})

describe("other shapes", () => {
  test("no numbers: counts instead of totals, and nothing that needs a number", () => {
    const t = FEES.map((x) =>
      x.name === "fee_register" ? { ...x, columns: x.columns.filter((c) => c.name !== "fee_paid") } : x,
    )
    const titles = starterSnippets(t).map((s) => s.title)
    expect(titles).toContain("fee_register rows per batch")
    expect(titles.some((x) => x.startsWith("Top 10") || x.startsWith("Add 100"))).toBe(false)
  })

  test("a single table without foreign keys still gets a start", () => {
    const one: SnippetTable[] = [{ name: "items", row_count: 5, columns: [pk, col("item"), col("price", "numeric")] }]
    expect(starterSnippets(one).map((s) => s.title)).toEqual(["First 50 rows of items", "Rows per item"])
  })

  test("nothing applied, nothing suggested", () => {
    expect(starterSnippets([])).toEqual([])
  })

  test("aliases stay distinct when tables share a first letter", () => {
    const t: SnippetTable[] = [
      { name: "sales", row_count: 10, columns: [pk, fk("shop_id", "shops"), col("amount", "numeric")] },
      { name: "shops", row_count: 2, columns: [pk, col("shop")] },
    ]
    expect(starterSnippets(t)[0].sql).toBe(
      "SELECT s.*, s2.shop\nFROM sales s\nJOIN shops s2 ON s2.id = s.shop_id\nLIMIT 50;",
    )
  })
})

describe("starterQuestions", () => {
  test("plain-English questions about the fee_register data", () => {
    expect(starterQuestions(FEES)).toEqual([
      "Which students have a fee_paid of 0 in the most recent month?",
      "Which batch has the highest total fee_paid?",
      "Who are the top 5 students by total fee_paid?",
      "Which students have no fee_register rows?",
      "How many rows does each table have?",
    ])
  })

  test("without a number column it counts rows; without foreign keys it stays general", () => {
    const t = FEES.map((x) =>
      x.name === "fee_register" ? { ...x, columns: x.columns.filter((c) => c.name !== "fee_paid") } : x,
    )
    expect(starterQuestions(t)).toEqual([
      "Which batch has the most fee_register rows?",
      "Which students have no fee_register rows?",
      "How many rows does each table have?",
    ])
    expect(starterQuestions([{ name: "items", row_count: 5, columns: [pk, col("item")] }])).toEqual([
      "How many rows does each table have?",
      "Show 10 rows of items",
    ])
    expect(starterQuestions([])).toEqual([])
  })
})
