import { describe, expect, test } from "vitest"
import { layoutEr } from "./graphLayout"
import { laneVar } from "./lanes"
import type { ProposedColumnOut, TableOut } from "./types"

// The fee-register design as POST /proposal builds it (ids and names from a real run).
const col = (
  id: number,
  name: string,
  role: ProposedColumnOut["role"],
  data_type = "text",
  references_table_id: number | null = null,
  not_null = true,
): ProposedColumnOut => ({
  id,
  name,
  data_type,
  role,
  not_null,
  references_table_id,
  source_column: role === "attribute" ? name : null,
  source_label: null,
})

const FEE: TableOut[] = [
  {
    id: 1,
    name: "students",
    kind: "entity",
    color_index: 0,
    explanation:
      "Each Student Name has one Student Phone and Batch, so they are stored once here instead of on every row.",
    columns: [
      col(1, "id", "pk", "bigint"),
      col(2, "student_name", "attribute"),
      col(3, "student_phone", "attribute"),
      col(4, "batch_id", "fk", "bigint", 2),
    ],
    unique_keys: [["student_name"], ["student_phone"]],
  },
  {
    id: 2,
    name: "batches",
    kind: "entity",
    color_index: 1,
    explanation: "Each Batch has one Teacher, so they are stored once here instead of on every row.",
    columns: [col(5, "id", "pk", "bigint"), col(6, "batch", "attribute"), col(7, "teacher_id", "fk", "bigint", 3)],
    unique_keys: [["batch"]],
  },
  {
    id: 3,
    name: "teachers",
    kind: "entity",
    color_index: 2,
    explanation: "Each Teacher has one Teacher Phone, so they are stored once here instead of on every row.",
    columns: [col(8, "id", "pk", "bigint"), col(9, "teacher", "attribute"), col(10, "teacher_phone", "attribute")],
    unique_keys: [["teacher"], ["teacher_phone"]],
  },
  {
    id: 4,
    name: "fee_register",
    kind: "fact",
    color_index: 3,
    explanation: "One row per original sheet row, identified by Student Name + Month.",
    columns: [
      col(11, "id", "pk", "bigint"),
      col(12, "student_id", "fk", "bigint", 1),
      col(13, "month", "attribute"),
      col(14, "fee_paid", "attribute", "bigint"),
      col(15, "payment_mode", "attribute", "text", null, false),
    ],
    unique_keys: [["student_id", "month"]],
  },
]

describe("layoutEr", () => {
  const { nodes, edges } = layoutEr(FEE)
  const nameOf = new Map(nodes.map((n) => [n.id, n.data.table.name]))

  test("one node per table", () => {
    expect(nodes).toHaveLength(4)
    expect(nodes.map((n) => n.data.table.name).sort()).toEqual(["batches", "fee_register", "students", "teachers"])
  })

  test("one edge per foreign key, from the referencing table to the referenced one", () => {
    expect(edges).toHaveLength(3)
    const pairs = edges.map((e) => `${nameOf.get(e.source)}→${nameOf.get(e.target)}`).sort()
    expect(pairs).toEqual(["batches→teachers", "fee_register→students", "students→batches"])
  })

  test("edges leave from the fk column's handle and land on the referenced table's key", () => {
    const e = edges.find((x) => nameOf.get(x.source) === "fee_register")!
    expect(e.sourceHandle).toBe("c-12")
    expect(e.targetHandle).toBe("pk")
  })

  test("the fact table sits furthest right", () => {
    const fact = nodes.find((n) => n.data.table.kind === "fact")!
    for (const n of nodes) if (n !== fact) expect(fact.position.x).toBeGreaterThan(n.position.x)
  })

  test("referenced tables sit left of the tables that point at them", () => {
    const x = new Map(nodes.map((n) => [n.data.table.name, n.position.x]))
    expect(x.get("teachers")!).toBeLessThan(x.get("batches")!)
    expect(x.get("batches")!).toBeLessThan(x.get("students")!)
  })

  test("an edge takes the referenced table's lane colour", () => {
    const tableOf = new Map(FEE.map((t) => [`t-${t.id}`, t]))
    for (const e of edges) {
      const color = laneVar(tableOf.get(e.target)!.color_index)
      expect(e.style?.stroke).toBe(color)
      expect(e.data?.color).toBe(color)
    }
  })

  test("taller tables get taller nodes", () => {
    const h = new Map(nodes.map((n) => [n.data.table.name, n.height!]))
    expect(h.get("fee_register")!).toBeGreaterThan(h.get("batches")!)
  })

  test("nodes are numbered left to right for the entrance", () => {
    const byOrder = [...nodes].sort((a, b) => a.data.order - b.data.order)
    expect(byOrder.map((n) => n.data.table.name)[0]).toBe("teachers")
    expect(byOrder.at(-1)!.data.table.name).toBe("fee_register")
  })

  test("a foreign key to a table that isn't there draws no edge", () => {
    const lone = layoutEr([FEE[0]])
    expect(lone.nodes).toHaveLength(1)
    expect(lone.edges).toHaveLength(0)
  })

  test("the fact table stays rightmost even when nothing chains into it", () => {
    // fact points only at teachers; students → batches is a longer chain beside it
    const fact: TableOut = {
      ...FEE[3],
      columns: [col(11, "id", "pk", "bigint"), col(12, "teacher_id", "fk", "bigint", 3)],
    }
    const { nodes: ns } = layoutEr([FEE[0], FEE[1], FEE[2], fact])
    const f = ns.find((n) => n.data.table.kind === "fact")!
    for (const n of ns) if (n !== f) expect(f.position.x).toBeGreaterThan(n.position.x)
  })
})
