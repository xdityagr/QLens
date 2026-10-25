import { describe, expect, it } from "vitest"
import { buildAnatomy } from "./anatomy"
import { layoutAnatomy, NODE_H, NODE_W } from "./anatomyLayout"
import type { AnalysisOut, ColumnOut, FDOut, InferredType } from "./types"

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
    sentence: `Each ${lhs.join(" + ")} has exactly one ${rhs}`,
    ...extra,
  }
}

function col(name: string, ordinal: number, inferred_type: InferredType = "text"): ColumnOut {
  return {
    id: ordinal,
    ordinal,
    name,
    label: name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    inferred_type,
    null_count: 0,
    distinct_count: 10,
    sample_values: [],
  }
}

// The fee register as the backend reports it on the sample sheet.
const FEE_COLS = ["student_name", "student_phone", "batch", "teacher", "teacher_phone", "month", "fee_paid", "payment_mode"]
function feeRegister(): AnalysisOut {
  const fds = [
    fd(["student_name"], "student_phone"),
    fd(["student_name"], "batch", { is_derived: true }),
    fd(["student_phone"], "student_name", { is_exact: false, violating_rows: 8 }),
    fd(["student_phone"], "batch"),
    fd(["batch"], "teacher"),
    fd(["teacher"], "teacher_phone", { is_exact: false, violating_rows: 5 }),
    fd(["teacher_phone"], "teacher"),
  ]
  return {
    dataset_id: 1,
    row_count: 3000,
    keys: [
      ["student_name", "month"],
      ["student_phone", "month"],
    ],
    fds,
    duplicates: [],
    inconsistencies: [],
  }
}
const feeCols = FEE_COLS.map((n, i) => col(n, i + 1, n === "fee_paid" ? "integer" : "text"))

describe("buildAnatomy", () => {
  it("draws one edge per visible dependency, coloured by its determinant's lane", () => {
    const a = feeRegister()
    const g = buildAnatomy(a, feeCols, { showDerived: false })
    expect(g.edges.map((e) => [e.source, e.target, e.lane, e.kind])).toEqual([
      ["student_name", "student_phone", 0, "exact"],
      ["student_phone", "student_name", 1, "approx"],
      ["student_phone", "batch", 1, "exact"],
      ["batch", "teacher", 2, "exact"],
      ["teacher", "teacher_phone", 3, "approx"],
      ["teacher_phone", "teacher", 4, "exact"],
    ])
    const approx = g.edges.find((e) => e.kind === "approx" && e.source === "teacher")!
    expect(approx.violatingRows).toBe(5)
    expect(approx.fdId).toBe(a.fds[5].id)
  })

  it("hides derived dependencies unless asked, without shifting lanes", () => {
    const g = buildAnatomy(feeRegister(), feeCols, { showDerived: true })
    const derived = g.edges.filter((e) => e.derived)
    expect(derived.map((e) => [e.source, e.target, e.lane])).toEqual([["student_name", "batch", 0]])
    expect(g.edges.find((e) => e.source === "batch")!.lane).toBe(2)
  })

  it("puts columns no dependency touches in a separate loose list, in sheet order", () => {
    const g = buildAnatomy(feeRegister(), feeCols, { showDerived: false })
    expect(g.columns.map((c) => c.name)).toEqual(["student_name", "student_phone", "batch", "teacher", "teacher_phone"])
    expect(g.loose.map((c) => c.name)).toEqual(["month", "fee_paid", "payment_mode"])
  })

  it("marks the first candidate key as the row identity and the others as alternates", () => {
    const g = buildAnatomy(feeRegister(), feeCols, { showDerived: false })
    expect(g.primaryKey).toEqual(["student_name", "month"])
    expect(g.alternateKeys).toEqual([["student_phone", "month"]])
    const role = (n: string) => [...g.columns, ...g.loose].find((c) => c.name === n)!.keyRole
    expect(role("student_name")).toBe("primary")
    expect(role("month")).toBe("primary")
    expect(role("student_phone")).toBe("alternate")
    expect(role("batch")).toBeNull()
  })

  it("gives a column its lane when it determines something on its own", () => {
    const g = buildAnatomy(feeRegister(), feeCols, { showDerived: false })
    const lane = (n: string) => g.columns.find((c) => c.name === n)!.lane
    expect(lane("student_name")).toBe(0)
    expect(lane("batch")).toBe(2)
    expect(g.loose.find((c) => c.name === "fee_paid")!.lane).toBeNull()
  })

  it("routes a two-column determinant through one shared join node", () => {
    const a: AnalysisOut = {
      ...feeRegister(),
      keys: [["student", "date", "meal"]],
      fds: [
        fd(["menu_item"], "meal"),
        fd(["date", "meal"], "menu_item"),
        fd(["date", "meal"], "cook", { is_exact: false, violating_rows: 2 }),
      ],
    }
    const cols = ["student", "date", "meal", "menu_item", "cook"].map((n, i) => col(n, i + 1))
    const g = buildAnatomy(a, cols, { showDerived: false })
    expect(g.joins).toEqual([{ id: 'join:["date","meal"]', lhs: ["date", "meal"], lane: 1 }])
    expect(g.edges.map((e) => [e.source, e.target, e.kind])).toEqual([
      ["menu_item", "meal", "exact"],
      ["date", 'join:["date","meal"]', "join"],
      ["meal", 'join:["date","meal"]', "join"],
      ['join:["date","meal"]', "menu_item", "exact"],
      ['join:["date","meal"]', "cook", "approx"],
    ])
    expect(g.loose.map((c) => c.name)).toEqual(["student"])
  })

  it("keeps rejected dependencies as unaccepted edges", () => {
    const a = feeRegister()
    a.fds[4] = { ...a.fds[4], accepted: false }
    const g = buildAnatomy(a, feeCols, { showDerived: false })
    expect(g.edges.find((e) => e.source === "batch")!.accepted).toBe(false)
  })

  it("falls back to the identifiers when the column profile hasn't loaded", () => {
    const g = buildAnatomy(feeRegister(), [], { showDerived: false })
    expect(g.columns.find((c) => c.name === "batch")!.label).toBe("batch")
    expect(g.loose.map((c) => c.name)).toEqual(["month"])
  })
})

describe("layoutAnatomy", () => {
  it("places determinants before the columns they determine, left to right", () => {
    const a: AnalysisOut = { ...feeRegister(), fds: [fd(["a"], "b"), fd(["b"], "c")], keys: [] }
    const g = buildAnatomy(a, ["a", "b", "c"].map((n, i) => col(n, i + 1)), { showDerived: false })
    const l = layoutAnatomy(g, "LR")
    const x = (id: string) => l.nodes.find((n) => n.id === id)!.x
    expect(x("a")).toBeLessThan(x("b"))
    expect(x("b")).toBeLessThan(x("c"))
    expect(l.nodes.find((n) => n.id === "a")).toMatchObject({ w: NODE_W, h: NODE_H })
    expect(l.width).toBeGreaterThanOrEqual(3 * NODE_W)
  })

  it("stacks top to bottom in TB mode", () => {
    const a: AnalysisOut = { ...feeRegister(), fds: [fd(["a"], "b")], keys: [] }
    const g = buildAnatomy(a, ["a", "b"].map((n, i) => col(n, i + 1)), { showDerived: false })
    const l = layoutAnatomy(g, "TB")
    const y = (id: string) => l.nodes.find((n) => n.id === id)!.y
    expect(y("a")).toBeLessThan(y("b"))
  })

  it("gives every edge a routed path and orders nodes for the entrance", () => {
    const g = buildAnatomy(feeRegister(), feeCols, { showDerived: false })
    const l = layoutAnatomy(g, "LR")
    expect(l.edges).toHaveLength(g.edges.length)
    for (const e of l.edges) expect(e.points.length).toBeGreaterThanOrEqual(2)
    // approximate edges carry a label position for their "except in N rows" pill
    expect(l.edges.filter((e) => e.label).length).toBe(2)
    const order = l.nodes.map((n) => n.order)
    expect(new Set(order).size).toBe(order.length)
    const first = l.nodes.find((n) => n.order === 0)!
    expect(first.x).toBe(Math.min(...l.nodes.map((n) => n.x)))
  })
})
