import { describe, expect, it } from "vitest"
import { diffProposals, matchTables, stableIds } from "./proposalDiff"
import type { ProposedColumnOut, TableOut } from "./types"

let colId = 1000
function col(name: string, role: ProposedColumnOut["role"], source: string | null = null, ref: number | null = null) {
  return {
    id: colId++,
    name,
    data_type: "text",
    role,
    not_null: true,
    references_table_id: ref,
    source_column: source,
    source_label: source,
  } satisfies ProposedColumnOut
}

/** fee_register's draft as POST /proposal returns it, with ids offset per version */
function feeDesign(base: number, names = { students: "students", fee: "fee_register" }): TableOut[] {
  return [
    {
      id: base,
      name: names.students,
      kind: "entity",
      color_index: 0,
      explanation: "",
      columns: [
        col("id", "pk"),
        col("student_name", "attribute", "student_name"),
        col("student_phone", "attribute", "student_phone"),
        col("batch_id", "fk", null, base + 1),
      ],
      unique_keys: [["student_name"]],
    },
    {
      id: base + 1,
      name: "batches",
      kind: "entity",
      color_index: 1,
      explanation: "",
      columns: [col("id", "pk"), col("batch", "attribute", "batch"), col("teacher_id", "fk", null, base + 2)],
      unique_keys: [["batch"]],
    },
    {
      id: base + 2,
      name: "teachers",
      kind: "entity",
      color_index: 2,
      explanation: "",
      columns: [
        col("id", "pk"),
        col("teacher", "attribute", "teacher"),
        col("teacher_phone", "attribute", "teacher_phone"),
      ],
      unique_keys: [["teacher"]],
    },
    {
      id: base + 3,
      name: names.fee,
      kind: "fact",
      color_index: 3,
      explanation: "",
      columns: [col("id", "pk"), col("student_id", "fk", null, base), col("month", "attribute", "month")],
      unique_keys: [["student_id", "month"]],
    },
  ]
}

describe("matchTables", () => {
  it("pairs a renamed table in a new draft version with its old self by the sheet columns it holds", () => {
    const prev = feeDesign(10)
    const next = feeDesign(20, { students: "learners", fee: "fee_register" })
    const m = matchTables(prev, next)
    expect(m.get(20)).toBe(10) // learners <- students
    expect(m.get(21)).toBe(11)
    expect(m.get(22)).toBe(12)
    expect(m.get(23)).toBe(13)
  })

  it("prefers the same id, then the same name", () => {
    const prev = feeDesign(10)
    const next = prev.map((t) => (t.id === 10 ? { ...t, name: "learners" } : t))
    const m = matchTables(prev, next)
    expect([...m.entries()].every(([a, b]) => a === b)).toBe(true)
  })

  it("leaves genuinely new tables unmatched", () => {
    const prev = feeDesign(10).filter((t) => t.name !== "teachers")
    const next = feeDesign(20)
    const m = matchTables(prev, next)
    expect(m.has(22)).toBe(false)
    expect(m.size).toBe(3)
  })
})

describe("diffProposals", () => {
  it("is empty for the same design", () => {
    const d = diffProposals(feeDesign(10), feeDesign(10))
    expect(d.changes).toEqual([])
    expect(d.changedIds.size).toBe(0)
  })

  it("reports a table rename across versions as one change", () => {
    const d = diffProposals(feeDesign(10), feeDesign(20, { students: "learners", fee: "fee_register" }))
    expect(d.changes).toEqual([{ kind: "rename-table", from: "students", to: "learners" }])
    expect([...d.changedIds]).toEqual([20])
    expect(d.addedIds.size).toBe(0)
    expect(d.removedIds.size).toBe(0)
  })

  it("reports column renames, added and removed tables", () => {
    const prev = feeDesign(10)
    const next = feeDesign(20).filter((t) => t.name !== "teachers")
    // batches now holds the teacher itself (batch -> teacher no longer split out)
    next[1] = {
      ...next[1],
      columns: [next[1].columns[0], next[1].columns[1], col("teacher", "attribute", "teacher")],
    }
    next[0] = {
      ...next[0],
      columns: next[0].columns.map((c) => (c.name === "student_phone" ? { ...c, name: "phone" } : c)),
    }
    const d = diffProposals(prev, next)
    expect(d.changes).toContainEqual({ kind: "remove-table", name: "teachers" })
    expect(d.changes).toContainEqual({ kind: "rename-column", table: "students", from: "student_phone", to: "phone" })
    expect(d.changes).toContainEqual({ kind: "columns", table: "batches" })
    expect(d.changes).toHaveLength(3)
    expect(d.removedIds).toEqual(new Set([12]))
    expect(d.changedIds).toEqual(new Set([20, 21]))
  })

  it("reports a new table", () => {
    const prev = feeDesign(10).filter((t) => t.name !== "teachers")
    const d = diffProposals(prev, feeDesign(20))
    expect(d.changes).toContainEqual({ kind: "add-table", name: "teachers" })
    expect(d.addedIds).toEqual(new Set([22]))
  })
})

describe("stableIds", () => {
  it("keeps the node id a table was shown under when a new version renames it", () => {
    const prev = feeDesign(10)
    const shown = stableIds([], new Map(), prev)
    expect(shown.get(10)).toBe("t-10")
    const next = feeDesign(20, { students: "learners", fee: "fee_register" })
    const ids = stableIds(prev, shown, next)
    expect(ids.get(20)).toBe("t-10")
    expect(ids.get(23)).toBe("t-13")
  })

  it("gives unmatched tables their own id", () => {
    const prev = feeDesign(10).filter((t) => t.name !== "teachers")
    const ids = stableIds(prev, stableIds([], new Map(), prev), feeDesign(20))
    expect(ids.get(22)).toBe("t-22")
    expect(new Set(ids.values()).size).toBe(4)
  })
})
