import { describe, expect, it } from "vitest"
import {
  PLAN_NODE_W,
  describeNode,
  heat,
  layoutPlan,
  misestimate,
  nodeHeight,
  chooseScaleFactor,
  indexColumn,
  relationOf,
  speedupLabel,
  stepSentence,
  suggestionText,
  toTree,
  type PlanNode,
} from "./plan"

function node(over: Partial<PlanNode> & Pick<PlanNode, "id" | "parent_id">): PlanNode {
  return {
    depth: 0,
    node_type: "Seq Scan",
    relation: null,
    alias: null,
    index_name: null,
    filter: null,
    index_cond: null,
    join_type: null,
    hash_cond: null,
    est_rows: 1,
    actual_rows: 1,
    loops: 1,
    total_ms: 1,
    self_ms: 1,
    cost: 1,
    pct_of_total: 0,
    ...over,
  }
}

// Hash Join over a Seq Scan and a Hash (which reads another Seq Scan): the shape EXPLAIN gives a two-table join.
const JOIN: PlanNode[] = [
  node({ id: 0, parent_id: null, depth: 0, node_type: "Hash Join", total_ms: 10, self_ms: 2 }),
  node({ id: 1, parent_id: 0, depth: 1, node_type: "Seq Scan", relation: "fee_register", total_ms: 6, self_ms: 6 }),
  node({ id: 2, parent_id: 0, depth: 1, node_type: "Hash", total_ms: 2, self_ms: 1 }),
  node({ id: 3, parent_id: 2, depth: 2, node_type: "Seq Scan", relation: "students", total_ms: 1, self_ms: 1 }),
]

describe("toTree", () => {
  it("nests a 3-node plan by parent_id, children in plan order", () => {
    const tree = toTree(JOIN.slice(0, 3))
    expect(tree.node.id).toBe(0)
    expect(tree.children.map((c) => c.node.id)).toEqual([1, 2])
    expect(tree.children[0].children).toEqual([])
  })

  it("nests deeper levels", () => {
    const tree = toTree(JOIN)
    expect(tree.children[1].children.map((c) => c.node.id)).toEqual([3])
  })

  it("does not depend on the order the nodes arrive in", () => {
    const tree = toTree([...JOIN].reverse())
    expect(tree.node.id).toBe(0)
    expect(tree.children.map((c) => c.node.id)).toEqual([1, 2])
  })

  it("throws on a plan with no root", () => {
    expect(() => toTree([])).toThrow()
  })
})

describe("misestimate", () => {
  it("is the larger of estimate and actual over the smaller", () => {
    expect(misestimate({ est_rows: 10, actual_rows: 1000 })).toBe(100)
    expect(misestimate({ est_rows: 1000, actual_rows: 10 })).toBe(100)
    expect(misestimate({ est_rows: 50, actual_rows: 50 })).toBe(1)
  })

  it("treats zero as one, so an empty result is not infinitely off", () => {
    expect(misestimate({ est_rows: 0, actual_rows: 0 })).toBe(0)
    expect(misestimate({ est_rows: 20, actual_rows: 0 })).toBe(20)
  })

  it("counts every loop of the actual rows", () => {
    // 5 rows per loop x 40 loops = 200 rows really came out, against an estimate of 5 per loop x 40
    expect(misestimate({ est_rows: 5, actual_rows: 5, loops: 40 })).toBe(1)
  })
})

describe("heat", () => {
  it("is 1 for the hottest node and its share of that for the rest", () => {
    expect(heat(JOIN[1], 6)).toBe(1)
    expect(heat(JOIN[0], 6)).toBeCloseTo(1 / 3)
  })

  it("is 0 when nothing took any time", () => {
    expect(heat(node({ id: 0, parent_id: null, self_ms: 0 }), 0)).toBe(0)
  })

  it("stays within 0..1", () => {
    expect(heat(node({ id: 0, parent_id: null, self_ms: 9 }), 3)).toBe(1)
  })
})

describe("layoutPlan", () => {
  const { nodes, edges } = layoutPlan(toTree(JOIN))

  it("has one node per plan node and one edge per parent link", () => {
    expect(nodes.map((n) => n.id).sort()).toEqual(["p-0", "p-1", "p-2", "p-3"])
    expect(edges.map((e) => `${e.source}>${e.target}`).sort()).toEqual(["p-0>p-1", "p-0>p-2", "p-2>p-3"])
  })

  it("grows top to bottom: the root on top, children below their parent", () => {
    const y = Object.fromEntries(nodes.map((n) => [n.id, n.position.y]))
    expect(y["p-0"]).toBeLessThan(y["p-1"])
    expect(y["p-2"]).toBeLessThan(y["p-3"])
  })

  it("keeps siblings side by side", () => {
    const x = Object.fromEntries(nodes.map((n) => [n.id, n.position.x]))
    expect(Math.abs(x["p-1"] - x["p-2"])).toBeGreaterThanOrEqual(PLAN_NODE_W)
  })

  it("marks the hottest node and gives each node its heat", () => {
    const hot = nodes.filter((n) => n.data.hottest).map((n) => n.id)
    expect(hot).toEqual(["p-1"])
    expect(nodes.find((n) => n.id === "p-1")!.data.heat).toBe(1)
  })

  it("orders the entrance from the root, level by level", () => {
    const order = Object.fromEntries(nodes.map((n) => [n.id, n.data.order]))
    expect(order["p-0"]).toBe(0)
    expect(order["p-1"]).toBeLessThan(order["p-3"])
    expect(order["p-2"]).toBeLessThan(order["p-3"])
  })

  it("labels each edge with the rows the child passed up", () => {
    const e = edges.find((x) => x.target === "p-3")!
    expect(e.data!.rows).toBe(1)
    expect(e.data!.order).toBe(nodes.find((n) => n.id === "p-3")!.data.order)
  })

  it("sizes nodes the way the card renders them", () => {
    for (const n of nodes) {
      expect(n.width).toBe(PLAN_NODE_W)
      expect(n.height).toBe(nodeHeight(n.data.node))
    }
  })
})

describe("relationOf", () => {
  it("uses the node's own relation, else the table its index belongs to", () => {
    const byIndex = { ix_fee_register_student_id: "fee_register" }
    expect(relationOf(node({ id: 0, parent_id: null, relation: "students" }), byIndex)).toBe("students")
    expect(
      relationOf(
        node({ id: 0, parent_id: null, node_type: "Bitmap Index Scan", index_name: "ix_fee_register_student_id" }),
        byIndex,
      ),
    ).toBe("fee_register")
    expect(relationOf(node({ id: 0, parent_id: null, node_type: "Hash" }), byIndex)).toBeNull()
  })
})

describe("describeNode", () => {
  it("says in plain words what the common steps do", () => {
    expect(describeNode("Seq Scan")).toBe("reads every row")
    expect(describeNode("Index Scan")).toBe("jumps straight to matching rows")
  })

  it("has a fallback for anything else", () => {
    expect(describeNode("Some Future Node")).toBe("")
  })
})

describe("speedupLabel", () => {
  it("rounds big speedups to whole numbers and small ones to one decimal", () => {
    expect(speedupLabel(37.46)).toBe("×37 faster")
    expect(speedupLabel(2.34)).toBe("×2.3 faster")
  })

  it("is honest when the index did not help", () => {
    expect(speedupLabel(1.02)).toBe("About the same")
    expect(speedupLabel(0.5)).toBe("×2.0 slower")
    expect(speedupLabel(null)).toBe("No timing")
  })
})

describe("stepSentence", () => {
  const byIndex = { ix_fee_register_student_id: "fee_register" }
  const n = (over: Partial<PlanNode>) => node({ id: 0, parent_id: null, ...over })

  it("says what a scan does to which table, in plain words", () => {
    expect(stepSentence(n({ node_type: "Seq Scan", relation: "fee_register" }), byIndex)).toBe(
      "Reads every row of fee_register",
    )
    expect(
      stepSentence(
        n({ node_type: "Index Scan", relation: "fee_register", index_name: "x", index_cond: "(student_id = 5)" }),
        byIndex,
      ),
    ).toBe("Uses the index on student_id to jump straight to matching rows of fee_register")
    expect(
      stepSentence(
        n({ node_type: "Bitmap Index Scan", index_name: "ix_fee_register_student_id", index_cond: "(student_id = 5)" }),
        byIndex,
      ),
    ).toBe("Finds the matching rows in the index on student_id")
    expect(stepSentence(n({ node_type: "Bitmap Heap Scan", relation: "fee_register" }), byIndex)).toBe(
      "Fetches those rows from fee_register",
    )
  })

  it("falls back to the index name, then to the step's own name", () => {
    expect(stepSentence(n({ node_type: "Index Scan", relation: "t", index_name: "t_pkey" }), {})).toBe(
      "Uses the index t_pkey to jump straight to matching rows of t",
    )
    expect(stepSentence(n({ node_type: "Some Future Node" }), {})).toBe("Some Future Node")
  })
})

describe("indexColumn", () => {
  it("reads the column an index condition looks up", () => {
    expect(indexColumn("(student_id = 5)")).toBe("student_id")
    expect(indexColumn("((f.month)::text = 'Jan'::text)")).toBe("month")
    expect(indexColumn('("Student Id" >= 3)')).toBe("Student Id")
    expect(indexColumn("(phone IS NULL)")).toBe("phone")
    expect(indexColumn(null)).toBeNull()
  })
})

describe("suggestionText", () => {
  const plan = {
    planning_ms: 0.1,
    execution_ms: 1,
    nodes: [],
    snapshot_id: 1,
    plan: {
      Plan: {
        "Node Type": "Seq Scan",
        "Relation Name": "fee_register",
        "Actual Rows": 10,
        "Actual Loops": 1,
        "Rows Removed by Filter": 2990,
      },
    },
  }

  it("counts rows read against rows kept, from the plan itself", () => {
    expect(suggestionText({ table: "fee_register", columns: ["student_id"], reason: "r" }, plan)).toEqual({
      problem: "This query reads all 3,000 rows of fee_register to find 10.",
      fix: "An index on student_id would let PostgreSQL jump straight to them.",
    })
  })

  it("falls back to the advisor's own reason when the plan has no such scan", () => {
    expect(suggestionText({ table: "students", columns: ["batch_id", "id"], reason: "because" }, plan)).toEqual({
      problem: "because",
      fix: "An index on (batch_id, id) would let PostgreSQL jump straight to them.",
    })
  })
})

describe("chooseScaleFactor", () => {
  it("grows the biggest table to about 150,000 rows", () => {
    expect(chooseScaleFactor(3000)).toBe(50)
    expect(chooseScaleFactor(100)).toBe(200)
  })

  it("stays within the lab's limits, and skips scaling a table that is big already", () => {
    expect(chooseScaleFactor(60_000)).toBe(2)
    expect(chooseScaleFactor(100_000)).toBeNull()
    expect(chooseScaleFactor(0)).toBeNull()
  })
})
