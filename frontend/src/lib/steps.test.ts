import { expect, test } from "vitest"
import { nextStep, stepStates } from "./steps"

const states = (stage: Parameters<typeof stepStates>[0]) => stepStates(stage).map((s) => `${s.key}:${s.state}`)

test("empty workspace starts at import, everything else locked", () => {
  expect(states("empty")).toEqual([
    "import:current",
    "analyze:locked",
    "design:locked",
    "data:locked",
    "history:locked",
  ])
})

test("analyzed workspace moves on to design", () => {
  expect(states("analyzed")).toEqual(["import:done", "analyze:done", "design:current", "data:locked", "history:locked"])
})

test("applied workspace opens data (next) and history; query and performance live inside Data", () => {
  expect(states("applied")).toEqual(["import:done", "analyze:done", "design:done", "data:current", "history:open"])
  expect(nextStep("applied")).toBe("data")
})
