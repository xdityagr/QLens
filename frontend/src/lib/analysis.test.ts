import { describe, expect, it } from "vitest"
import { conflictKey, groupFdsByLhs, healthSummary, inconsistencyEntries } from "./analysis"
import type { AnalysisOut, DuplicateGroupOut, FDOut, InconsistencyOut } from "./types"

let nextId = 1
function fd(lhs: string[], rhs: string, extra: Partial<FDOut> = {}): FDOut {
  return {
    id: nextId++,
    lhs,
    rhs,
    is_exact: true,
    violating_rows: 0,
    violation_ratio: 0,
    accepted: true,
    is_derived: false,
    sentence: `Each ${lhs.join(" and ")} has exactly one ${rhs}`,
    ...extra,
  }
}

function group(
  status: DuplicateGroupOut["status"],
  confidence: DuplicateGroupOut["confidence"] = "same_normalized",
): DuplicateGroupOut {
  return {
    id: nextId++,
    column: "student_name",
    canonical_value: "Riya Sharma",
    confidence,
    max_similarity: 1,
    status,
    values: [
      { value: "Riya Sharma", rows: 8 },
      { value: "riya sharma", rows: 1 },
    ],
  }
}

function analysis(fds: FDOut[], duplicates: DuplicateGroupOut[]): AnalysisOut {
  return { dataset_id: 1, row_count: 3000, keys: [["student_name", "month"]], fds, duplicates, inconsistencies: [] }
}

describe("healthSummary", () => {
  it("counts pending duplicate groups and rows that break approximate dependencies", () => {
    const a = analysis(
      [
        fd(["batch"], "teacher"),
        fd(["student_phone"], "student_name", { is_exact: false, violating_rows: 8, violation_ratio: 8 / 3000 }),
        fd(["teacher"], "teacher_phone", { is_exact: false, violating_rows: 5, violation_ratio: 5 / 3000 }),
      ],
      [group("pending"), group("pending", "similar"), group("merged"), group("dismissed")],
    )
    expect(healthSummary(a)).toEqual({ issues: 4, duplicates: 2, inconsistentRows: 13 })
  })

  it("ignores approximate dependencies the user rejected", () => {
    const a = analysis([fd(["teacher"], "teacher_phone", { is_exact: false, violating_rows: 5, accepted: false })], [])
    expect(healthSummary(a)).toEqual({ issues: 0, duplicates: 0, inconsistentRows: 0 })
  })

  it("is all zeros for a clean analysis", () => {
    expect(healthSummary(analysis([fd(["batch"], "teacher")], [group("merged")]))).toEqual({
      issues: 0,
      duplicates: 0,
      inconsistentRows: 0,
    })
  })
})

describe("groupFdsByLhs", () => {
  it("groups by determinant, keeping first-seen group order and FD order inside each group", () => {
    const a1 = fd(["student_name"], "student_phone")
    const b1 = fd(["batch"], "teacher")
    const a2 = fd(["student_name"], "batch")
    const c1 = fd(["student_name", "month"], "fee_paid")
    const b2 = fd(["batch"], "teacher_phone")
    const groups = groupFdsByLhs([a1, b1, a2, c1, b2])
    expect(groups.map((g) => g.lhs)).toEqual([["student_name"], ["batch"], ["student_name", "month"]])
    expect(groups.map((g) => g.fds.map((f) => f.id))).toEqual([[a1.id, a2.id], [b1.id, b2.id], [c1.id]])
  })

  it("does not merge determinants that only differ by column order boundaries", () => {
    const groups = groupFdsByLhs([fd(["a_b"], "x"), fd(["a", "b"], "x")])
    expect(groups).toHaveLength(2)
  })

  it("returns an empty list for no dependencies", () => {
    expect(groupFdsByLhs([])).toEqual([])
  })
})

describe("conflictKey", () => {
  // Must equal Python's json.dumps(lhs_values), which the fix endpoint uses as the override key.
  it("formats like json.dumps", () => {
    expect(conflictKey(["Mr. Gupta"])).toBe('["Mr. Gupta"]')
    expect(conflictKey(["JEE Morning", "Apr", 3, null, true])).toBe('["JEE Morning", "Apr", 3, null, true]')
    expect(conflictKey(['Say "hi"'])).toBe('["Say \\"hi\\""]')
    const u = String.fromCharCode(92) + "u"
    expect(conflictKey(["Café ₹"])).toBe(`["Caf${u}00e9 ${u}20b9"]`)
  })
})

describe("inconsistencyEntries", () => {
  const item = (f: FDOut): InconsistencyOut => ({ fd_id: f.id, sentence: f.sentence, lhs: f.lhs, rhs: f.rhs, conflicts: [] })

  it("lists every accepted approximate dependency, with its conflicts when the backend sent them", () => {
    const exact = fd(["batch"], "teacher")
    const a1 = fd(["student_phone"], "student_name", { is_exact: false, violating_rows: 8 })
    const a2 = fd(["teacher"], "teacher_phone", { is_exact: false, violating_rows: 5 })
    const rejected = fd(["month"], "fee_paid", { is_exact: false, violating_rows: 3, accepted: false })
    const entries = inconsistencyEntries([exact, a1, a2, rejected], [item(a2)])
    expect(entries.map((e) => [e.fdId, e.fd?.id, e.item?.fd_id])).toEqual([
      [a1.id, a1.id, undefined],
      [a2.id, a2.id, a2.id],
    ])
  })

  it("keeps an inconsistency whose dependency is no longer approximate and accepted at the end", () => {
    const gone = fd(["teacher"], "teacher_phone")
    const entries = inconsistencyEntries([gone], [item(gone)])
    expect(entries.map((e) => [e.fdId, e.fd?.id])).toEqual([[gone.id, gone.id]])
  })
})
