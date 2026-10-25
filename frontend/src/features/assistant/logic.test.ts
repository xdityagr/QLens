import { describe, expect, it } from "vitest"
import { ApiError } from "../../lib/api"
import type { TableOut } from "../../lib/types"
import type { AssistantAction, ConversationDetail } from "./api"
import {
  attachRuns,
  chipFor,
  designSuggestions,
  editSummary,
  friendlyError,
  presentationFor,
  querySuggestions,
  RATE_LIMITED,
  threadFromDetail,
  typewriterCuts,
} from "./logic"

const act = (tool: string, args: Record<string, unknown>, summary: string, ok = true): AssistantAction => ({
  tool,
  args,
  ok,
  summary,
})

describe("chipFor", () => {
  it("shortens a dependency check to its verdict", () => {
    const c = chipFor(
      act("check_dependency", { lhs: ["batch"], rhs: "teacher" }, "Checked batch → teacher: holds in every row"),
    )
    expect(c).toMatchObject({ label: "Checked batch → teacher: exact", tone: "check" })
    const broken = chipFor(
      act("check_dependency", { lhs: ["batch"], rhs: "fee_paid" }, "Checked batch → fee_paid: broken in 812 rows"),
    )
    expect(broken.label).toBe("Checked batch → fee_paid: broken in 812 rows")
  })

  it("names renames with an arrow", () => {
    expect(
      chipFor(act("rename_table", { table: "students", new_name: "learners" }, "Renamed table students to learners")),
    ).toMatchObject({ label: "Renamed students → learners", tone: "edit" })
    expect(
      chipFor(act("rename_column", { table: "students", column: "student_phone", new_name: "phone" }, "x")).label,
    ).toBe("Renamed students.student_phone → phone")
  })

  it("labels reads, SQL and dependency switches", () => {
    expect(chipFor(act("describe_schema", {}, "Read the workspace schema")).label).toBe("Read the schema")
    expect(chipFor(act("run_sql", { sql: "select 1" }, "Ran a query (12 rows)"))).toMatchObject({
      label: "Ran a query: 12 rows",
      tone: "sql",
    })
    expect(chipFor(act("run_sql", { sql: "select 1" }, "Ran a query (50+ rows)")).label).toBe("Ran a query: 50+ rows")
    expect(
      chipFor(act("set_dependency_accepted", { lhs: ["batch"], rhs: "teacher", accepted: false }, "Stopped using …"))
        .label,
    ).toBe("Stopped using batch → teacher")
    expect(chipFor(act("undo_last_edit", {}, "Undid the last design change")).label).toBe("Undid the last change")
  })

  it("marks failures and keeps the reason as detail", () => {
    const c = chipFor(
      act(
        "rename_table",
        { table: "students", new_name: "teachers" },
        "rename_table failed: There is already a table called teachers.",
        false,
      ),
    )
    expect(c.tone).toBe("fail")
    expect(c.label).toBe("Couldn't rename students")
    expect(c.detail).toBe("There is already a table called teachers.")
  })

  it("derives a label from a stored tool call that has no summary", () => {
    const c = chipFor({
      tool: "check_dependency",
      args: { lhs: ["batch"], rhs: "teacher" },
      ok: true,
      result: { lhs: ["batch"], rhs: "teacher", exact: true, violating_rows: 0 },
    })
    expect(c.label).toBe("Checked batch → teacher: exact")
    const s = chipFor({ tool: "run_sql", args: { sql: "x" }, ok: true, result: { row_count: 3, truncated: false } })
    expect(s.label).toBe("Ran a query: 3 rows")
    const f = chipFor({ tool: "run_sql", args: { sql: "x" }, ok: false, error: "column nope does not exist" })
    expect(f).toMatchObject({ label: "Query failed", tone: "fail", detail: "column nope does not exist" })
  })
})

describe("presentationFor", () => {
  it("keeps the sidebar closed and toasts for an edit on the Design canvas", () => {
    expect(presentationFor("edit", "design")).toEqual({ openSidebar: false, toast: true })
  })
  it("opens the sidebar for answers, and for everything on the Query screen", () => {
    expect(presentationFor("answer", "design")).toEqual({ openSidebar: true, toast: false })
    expect(presentationFor("answer", "query")).toEqual({ openSidebar: true, toast: false })
    expect(presentationFor("edit", "query")).toEqual({ openSidebar: true, toast: false })
  })
})

describe("editSummary", () => {
  const rename = act("rename_table", { table: "students", new_name: "learners" }, "Renamed table students to learners")
  it("counts design changes from the diff when there is one", () => {
    const s = editSummary([rename], [{ kind: "rename-table", from: "students", to: "learners" }])
    expect(s).toEqual({ count: 1, title: "1 change", lines: ["Renamed students → learners"], undoable: true })
  })
  it("falls back to the successful edit tools", () => {
    const s = editSummary(
      [
        rename,
        act("describe_schema", {}, "Read"),
        act("rename_column", { table: "learners", column: "student_name", new_name: "name" }, "x"),
      ],
      null,
    )
    expect(s.count).toBe(2)
    expect(s.title).toBe("2 changes")
  })
  it("does not offer Undo for an undo", () => {
    const s = editSummary([act("undo_last_edit", {}, "Undid the last design change")], null)
    expect(s.undoable).toBe(false)
    expect(s.title).toBe("Undid the last change")
    expect(s.lines).toEqual([]) // the title already says it
  })
  it("says so when an edit left the design as it was", () => {
    const s = editSummary([act("rebuild_design", {}, "Rebuilt")], [])
    expect(s.title).toBe("No visible changes")
  })
})

describe("friendlyError", () => {
  it("turns Gemini's 429 into a rate-limit message", () => {
    const e = new ApiError(
      502,
      "assistant_upstream_error",
      "The assistant could not get an answer from Gemini.",
      "429 RESOURCE_EXHAUSTED. quota",
    )
    expect(friendlyError(e)).toMatchObject({
      kind: "rate",
      message: RATE_LIMITED,
    })
  })
  it("keeps other upstream errors distinct", () => {
    const e = new ApiError(
      502,
      "assistant_upstream_error",
      "The assistant could not get an answer from Gemini. Try again in a moment.",
      "timeout",
    )
    expect(friendlyError(e).kind).toBe("upstream")
    // no detail at all: the likely cause on the free tier, said as such
    const bare = friendlyError(new ApiError(502, "assistant_upstream_error", "x", null))
    expect(bare).toMatchObject({ kind: "upstream" })
    expect(bare.message).toMatch(/try again in a minute/)
  })
  it("explains a server without a key, and network failures", () => {
    expect(friendlyError(new ApiError(503, "assistant_disabled", "off")).kind).toBe("off")
    expect(friendlyError(new ApiError(0, "network_error", "Can't reach")).kind).toBe("network")
    expect(friendlyError(new Error("boom")).message).toBe("boom")
  })
})

describe("threadFromDetail", () => {
  it("rebuilds turns, chips and SQL results from a stored conversation", () => {
    const detail: ConversationDetail = {
      id: 4,
      context: "query",
      title: "unpaid",
      created_at: "",
      updated_at: "",
      messages: [
        { id: 1, seq: 1, role: "user", content: "show unpaid", intent: null, created_at: "", tool_calls: [] },
        {
          id: 2,
          seq: 2,
          role: "assistant",
          content: "Here they are.",
          intent: "answer",
          created_at: "",
          tool_calls: [
            {
              seq: 1,
              tool: "run_sql",
              args: { sql: "SELECT name FROM students" },
              ok: true,
              result: { columns: ["name"], rows: [["Asha"], ["Ravi"]], row_count: 2, truncated: false },
              error: null,
              query_run_id: 9,
            },
          ],
        },
      ],
    }
    const t = threadFromDetail(detail)
    expect(t).toHaveLength(2)
    expect(t[0]).toMatchObject({ role: "user", text: "show unpaid" })
    expect(t[1]).toMatchObject({ role: "assistant", text: "Here they are.", intent: "answer", fresh: false })
    expect(t[1].chips[0].label).toBe("Ran a query: 2 rows")
    expect(t[1].sqlRuns).toEqual([
      { sql: "SELECT name FROM students", row_count: 2, columns: [{ name: "name" }], rows: [["Asha"], ["Ravi"]] },
    ])
  })
})

const table = (
  id: number,
  name: string,
  kind: "entity" | "fact",
  attrs: string[],
  uk: string[][],
  refs: number[] = [],
): TableOut => ({
  id,
  name,
  kind,
  color_index: id,
  explanation: "",
  columns: [
    {
      id: id * 10,
      name: "id",
      data_type: "integer",
      role: "pk",
      not_null: true,
      references_table_id: null,
      source_column: null,
      source_label: null,
    },
    ...attrs.map((a, i) => ({
      id: id * 10 + i + 1,
      name: a,
      data_type: "text",
      role: "attribute" as const,
      not_null: true,
      references_table_id: null,
      source_column: a,
      source_label: a,
    })),
    ...refs.map((r, i) => ({
      id: id * 10 + 8 + i,
      name: `ref${r}_id`,
      data_type: "integer",
      role: "fk" as const,
      not_null: true,
      references_table_id: r,
      source_column: null,
      source_label: null,
    })),
  ],
  unique_keys: uk,
})

const FEE = [
  table(0, "students", "entity", ["student_name", "student_phone"], [["student_name"], ["student_phone"]], [1]),
  table(1, "batches", "entity", ["batch"], [["batch"]], [2]),
  table(2, "teachers", "entity", ["teacher", "teacher_phone"], [["teacher"], ["teacher_phone"]]),
  table(3, "fee_register", "fact", ["month", "fee_paid", "payment_mode"], [["ref0_id", "month"]], [0]),
]

describe("designSuggestions", () => {
  it("builds the three example prompts from the real design", () => {
    expect(designSuggestions(FEE)).toEqual([
      "Why is teacher_phone in teachers?",
      "Rename students to learners",
      "Does batch decide fee paid?",
    ])
  })
  it("falls back to a general question when the design gives nothing to point at", () => {
    expect(designSuggestions([])).toEqual(["What does each table hold?"])
  })
})

describe("querySuggestions", () => {
  it("asks about the real tables", () => {
    const s = querySuggestions([
      { name: "students", refs: ["batches"] },
      { name: "batches", refs: ["teachers"] },
      { name: "teachers", refs: [] },
      { name: "fee_register", refs: ["students"] },
    ])
    expect(s).toEqual([
      "How many rows does each table have?",
      "Show 10 rows of fee_register with names instead of ids",
      "Which students appear most often in fee_register?",
    ])
    expect(querySuggestions([])).toEqual(["How many rows does each table have?"])
  })
})

describe("typewriterCuts", () => {
  it("reveals whole words and ends at the full text", () => {
    const text = "Yes, batch decides teacher in every row."
    const cuts = typewriterCuts(text, 100)
    expect(cuts.at(-1)).toBe(text.length)
    for (const c of cuts.slice(0, -1)) expect(text[c] === " " || text[c] === "\n").toBe(true)
    expect([...cuts].sort((a, b) => a - b)).toEqual(cuts)
  })
  it("caps the number of steps for long answers", () => {
    const text = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ")
    const cuts = typewriterCuts(text, 60)
    expect(cuts.length).toBeLessThanOrEqual(60)
    expect(cuts.at(-1)).toBe(text.length)
  })
  it("is a single step for empty text", () => {
    expect(typewriterCuts("", 10)).toEqual([0])
  })
})

describe("attachRuns", () => {
  const run = (sql: string, n = 1) => ({ sql, row_count: n, columns: [{ name: "x" }], rows: [[1]] })

  it("puts a run on the fenced block with the same SQL, ignoring whitespace and a final semicolon", () => {
    const text = "Here it is:\n```sql\nSELECT name\n  FROM students;\n```\nDone."
    const r = attachRuns(text, [run("SELECT name FROM students", 300)])
    expect(r.byBlock).toEqual([run("SELECT name FROM students", 300)])
    expect(r.rest).toEqual([])
  })

  it("keeps runs that the text doesn't show, and blocks that weren't run", () => {
    const text = "```sql\nSELECT 1\n```\n\n```sql\nSELECT 2\n```"
    const r = attachRuns(text, [run("select 3"), run("SELECT  2")])
    expect(r.byBlock).toEqual([null, run("SELECT  2")])
    expect(r.rest).toEqual([run("select 3")])
  })

  it("uses each run once even if the reply repeats the SQL", () => {
    const text = "```sql\nSELECT 1\n```\n```sql\nSELECT 1\n```"
    const r = attachRuns(text, [run("SELECT 1")])
    expect(r.byBlock).toEqual([run("SELECT 1"), null])
  })
})

describe("friendlyError, round 2 codes", () => {
  it("reads the backend's 429 assistant_rate_limited", () => {
    expect(friendlyError(new ApiError(429, "assistant_rate_limited", "x"))).toMatchObject({
      kind: "rate",
      message: RATE_LIMITED,
    })
  })
  it("says plainly when there is nothing to undo", () => {
    expect(friendlyError(new ApiError(409, "nothing_to_undo", "There is no earlier version."))).toMatchObject({
      kind: "other",
      title: "Nothing to undo",
    })
  })
})
