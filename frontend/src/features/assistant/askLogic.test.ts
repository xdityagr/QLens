import { describe, expect, test } from "vitest"
import type { SnippetTable } from "../../lib/snippets"
import type { ConversationOut } from "./api"
import { askStarters, chatTitle, groupConversations } from "./askLogic"

const pk = { name: "id", data_type: "bigint", is_pk: true, fk: null }
const col = (name: string, data_type = "text") => ({ name, data_type, is_pk: false, fk: null })
const fk = (name: string, table: string) => ({ name, data_type: "bigint", is_pk: false, fk: { table, column: "id" } })

// The fee_register sample as Design applies it.
const FEES: SnippetTable[] = [
  { name: "students", row_count: 300, columns: [pk, col("student_name"), fk("batch_id", "batches")] },
  { name: "batches", row_count: 8, columns: [pk, col("batch"), fk("teacher_id", "teachers")] },
  { name: "teachers", row_count: 6, columns: [pk, col("teacher")] },
  {
    name: "fee_register",
    row_count: 3000,
    columns: [pk, fk("student_id", "students"), col("month"), col("fee_paid", "numeric"), col("payment_mode")],
  },
]

describe("askStarters", () => {
  test("fee_register: the schema-shaped questions, topped up to six without repeats", () => {
    expect(askStarters(FEES)).toEqual([
      "Which students have a fee_paid of 0 in the most recent month?",
      "Which batch has the highest total fee_paid?",
      "Who are the top 5 students by total fee_paid?",
      "Which students have no fee_register rows?",
      "How many rows does each table have?",
      "Show 10 rows of fee_register with names instead of ids",
    ])
  })

  test("a flat schema still offers what it can, and nothing for no tables", () => {
    expect(askStarters([{ name: "items", row_count: 5, columns: [pk, col("item")] }])).toEqual([
      "How many rows does each table have?",
      "Show 10 rows of items",
    ])
    expect(askStarters([])).toEqual([])
  })

  test("max caps the list", () => {
    expect(askStarters(FEES, 4)).toHaveLength(4)
  })
})

const conv = (id: number, updated_at: string): ConversationOut => ({
  id,
  context: "data",
  title: `c${id}`,
  updated_at,
  message_count: 2,
})

describe("groupConversations", () => {
  const now = new Date(2026, 9, 26, 15, 0) // 26 Oct 2026, 3 pm local

  test("buckets by local day, newest first, and drops empty buckets", () => {
    const groups = groupConversations(
      [
        conv(1, new Date(2026, 9, 26, 9, 0).toISOString()),
        conv(2, new Date(2026, 9, 25, 23, 0).toISOString()),
        conv(3, new Date(2026, 9, 21, 12, 0).toISOString()),
        conv(4, new Date(2026, 8, 1).toISOString()),
        conv(5, new Date(2026, 9, 26, 14, 0).toISOString()),
      ],
      now,
    )
    expect(groups.map((g) => [g.label, g.items.map((c) => c.id)])).toEqual([
      ["Today", [5, 1]],
      ["Yesterday", [2]],
      ["Previous 7 days", [3]],
      ["Older", [4]],
    ])
  })

  test("nothing to group", () => {
    expect(groupConversations([], now)).toEqual([])
    expect(groupConversations([conv(1, new Date(2026, 9, 26, 1).toISOString())], now).map((g) => g.label)).toEqual([
      "Today",
    ])
  })
})

test("chatTitle: stored title, else the first question, else New chat", () => {
  expect(chatTitle("Fees by batch", "Which batch…")).toBe("Fees by batch")
  expect(chatTitle(null, "  Which batch collects the most fees? ")).toBe("Which batch collects the most fees?")
  expect(chatTitle("", undefined)).toBe("New chat")
})
