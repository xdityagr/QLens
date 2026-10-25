// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ReactFlowProvider, type NodeProps } from "@xyflow/react"
import { afterEach, expect, test, vi } from "vitest"
import type { ErNode } from "../../lib/graphLayout"
import type { TableOut } from "../../lib/types"
import { ErContext, type ErContextValue } from "./erContext"
import { PK_READ_ONLY, TableNode } from "./TableNode"

afterEach(cleanup)

const students: TableOut = {
  id: 1,
  name: "students",
  kind: "entity",
  color_index: 0,
  explanation: "",
  unique_keys: [["student_name"]],
  columns: [
    { id: 10, name: "id", data_type: "bigint", role: "pk", not_null: true, references_table_id: null,
      source_column: null, source_label: null },
    { id: 11, name: "student_name", data_type: "text", role: "attribute", not_null: true, references_table_id: null,
      source_column: "student_name", source_label: "Student Name" },
  ],
}

function renderNode() {
  const rename = vi.fn().mockResolvedValue(undefined)
  const er: ErContextValue = {
    editable: true, rename, hovered: null, setHovered: () => {}, related: null, rowCounts: null, laneOf: new Map(),
  }
  const props = { data: { table: students } } as unknown as NodeProps<ErNode>
  render(
    <ReactFlowProvider>
      <ErContext.Provider value={er}>
        <TableNode {...props} />
      </ErContext.Provider>
    </ReactFlowProvider>,
  )
  return rename
}

test("the id column is shown read-only with the reason, even on an editable draft", () => {
  renderNode()
  const pk = screen.getByText("id")
  expect(pk.tagName).toBe("SPAN")
  expect(pk.getAttribute("title")).toBe(PK_READ_ONLY)
  fireEvent.doubleClick(pk)
  expect(screen.queryByRole("textbox")).toBeNull()
})

test("other columns still open the rename field on double-click", () => {
  renderNode()
  fireEvent.doubleClick(screen.getByRole("button", { name: "student_name" }))
  expect(screen.getByRole("textbox", { name: "Rename column student_name" })).toBeTruthy()
})
