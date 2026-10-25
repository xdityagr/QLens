import { expect, test } from "vitest"
import { stepStates } from "./steps"

const states = (stage: Parameters<typeof stepStates>[0]) =>
  stepStates(stage).map((s) => `${s.key}:${s.state}`)

test("empty workspace starts at import, everything else locked", () => {
  expect(states("empty")).toEqual([
    "import:current", "analyze:locked", "design:locked", "query:locked", "perf:locked", "history:locked",
  ])
})

test("analyzed workspace moves on to design", () => {
  expect(states("analyzed")).toEqual([
    "import:done", "analyze:done", "design:current", "query:locked", "perf:locked", "history:locked",
  ])
})

test("applied workspace opens query, performance and history", () => {
  expect(states("applied")).toEqual([
    "import:done", "analyze:done", "design:done", "query:current", "perf:open", "history:open",
  ])
})
