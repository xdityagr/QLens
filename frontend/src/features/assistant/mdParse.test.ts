import { describe, expect, it } from "vitest"
import { parseInline, parseMarkdown } from "./mdParse"

describe("parseInline", () => {
  it("reads code, bold, italic and links", () => {
    expect(parseInline("Use `batches` for **every** *row* [docs](https://x.dev/a)")).toEqual([
      { t: "text", v: "Use " },
      { t: "code", v: "batches" },
      { t: "text", v: " for " },
      { t: "b", c: [{ t: "text", v: "every" }] },
      { t: "text", v: " " },
      { t: "i", c: [{ t: "text", v: "row" }] },
      { t: "text", v: " " },
      { t: "a", href: "https://x.dev/a", c: [{ t: "text", v: "docs" }] },
    ])
  })

  it("leaves snake_case names alone", () => {
    expect(parseInline("teacher_phone and student_name_x")).toEqual([
      { t: "text", v: "teacher_phone and student_name_x" },
    ])
  })

  it("never turns a non-http link into a link", () => {
    expect(parseInline("[x](javascript:alert(1))")).toEqual([{ t: "text", v: "[x](javascript:alert(1))" }])
  })

  it("keeps markup inside code as text, and HTML as text", () => {
    expect(parseInline("`**a**` <b>hi</b>")).toEqual([
      { t: "code", v: "**a**" },
      { t: "text", v: " <b>hi</b>" },
    ])
  })

  it("treats an unclosed marker as text", () => {
    expect(parseInline("2 * 3 and **open")).toEqual([{ t: "text", v: "2 * 3 and **open" }])
  })
})

describe("parseMarkdown", () => {
  it("splits paragraphs, headings and lists", () => {
    const blocks = parseMarkdown("## Answer\nYes, it holds.\nIn every row.\n\n- one\n- two `x`\n\n1. first\n2) second")
    expect(blocks.map((b) => b.type)).toEqual(["h", "p", "ul", "ol"])
    expect(blocks[1]).toEqual({ type: "p", inlines: [{ t: "text", v: "Yes, it holds. In every row." }] })
    expect(blocks[2]).toMatchObject({
      type: "ul",
      items: [
        [{ t: "text", v: "one" }],
        [
          { t: "text", v: "two " },
          { t: "code", v: "x" },
        ],
      ],
    })
    expect(blocks[3]).toMatchObject({ type: "ol", items: [[{ t: "text", v: "first" }], [{ t: "text", v: "second" }]] })
  })

  it("keeps fenced code verbatim with its language, even unclosed", () => {
    const b = parseMarkdown("Run this:\n```sql\nSELECT *\n  FROM students;\n```\nDone.")
    expect(b[1]).toEqual({ type: "code", lang: "sql", text: "SELECT *\n  FROM students;" })
    expect(b[2]).toEqual({ type: "p", inlines: [{ t: "text", v: "Done." }] })
    expect(parseMarkdown("```\nSELECT 1")).toEqual([{ type: "code", lang: "", text: "SELECT 1" }])
  })

  it("reads a pipe table", () => {
    const b = parseMarkdown("| batch | teacher |\n|---|:--:|\n| B1 | `Rao` |\n| B2 | Iyer |")
    expect(b).toEqual([
      {
        type: "table",
        head: [[{ t: "text", v: "batch" }], [{ t: "text", v: "teacher" }]],
        rows: [
          [[{ t: "text", v: "B1" }], [{ t: "code", v: "Rao" }]],
          [[{ t: "text", v: "B2" }], [{ t: "text", v: "Iyer" }]],
        ],
      },
    ])
  })

  it("joins an indented continuation into the list item", () => {
    const b = parseMarkdown("* `batch` decides `teacher`\n  in all 3000 rows\n* next")
    expect(b[0]).toMatchObject({ type: "ul" })
    if (b[0].type !== "ul") throw new Error()
    expect(b[0].items[0].at(-1)).toEqual({ t: "text", v: " in all 3000 rows" })
  })

  it("reads ---, *** and ___ as a rule, which also ends a paragraph", () => {
    expect(parseMarkdown("Seven students tie.\n---\n**Evidence**").map((x) => x.type)).toEqual(["p", "hr", "p"])
    expect(parseMarkdown("* * *").map((x) => x.type)).toEqual(["hr"])
    expect(parseMarkdown("___").map((x) => x.type)).toEqual(["hr"])
    // a list item and a table separator are not rules
    expect(parseMarkdown("- item").map((x) => x.type)).toEqual(["ul"])
  })

  it("returns nothing for blank text", () => {
    expect(parseMarkdown("  \n\n")).toEqual([])
  })
})
