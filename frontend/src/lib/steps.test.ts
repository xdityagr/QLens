import { expect, test } from "vitest"
import { nextStep, stepStates } from "./steps"

const states = (stage: Parameters<typeof stepStates>[0]) => stepStates(stage).map((s) => `${s.key}:${s.state}`)

test("empty workspace starts at import, everything else locked", () => {
  expect(states("empty")).toEqual([
    "import:current",
    "analyze:locked",
    "design:locked",
    "data:locked",
    "ask:locked",
    "history:locked",
  ])
})

test("analyzed workspace moves on to design", () => {
  expect(states("analyzed")).toEqual([
    "import:done",
    "analyze:done",
    "design:current",
    "data:locked",
    "ask:locked",
    "history:locked",
  ])
})

test("applied workspace opens data (next), Ask AI and history; query and performance live inside Data", () => {
  expect(states("applied")).toEqual([
    "import:done",
    "analyze:done",
    "design:done",
    "data:current",
    "ask:open",
    "history:open",
  ])
  expect(nextStep("applied")).toBe("data")
})

test("Ask AI is its own step, after Data and before History", () => {
  const keys = stepStates("applied").map((s) => s.key)
  expect(keys).toEqual(["import", "analyze", "design", "data", "ask", "history"])
})

test("imported workspace: only analyze is next, Ask AI stays locked", () => {
  expect(states("imported")).toContain("analyze:current")
  expect(states("imported")).toContain("ask:locked")
})
