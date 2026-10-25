import { expect, test } from "vitest"
import { laneAlpha, laneVar } from "./lanes"

test("laneVar wraps at 8", () => {
  expect(laneVar(9)).toBe("var(--lane-1)")
})

test("laneVar keeps indexes below 8", () => {
  expect(laneVar(0)).toBe("var(--lane-0)")
  expect(laneVar(7)).toBe("var(--lane-7)")
})

test("laneAlpha mixes the lane with transparent", () => {
  expect(laneAlpha(10, 0.18)).toBe("color-mix(in oklab, var(--lane-2) 18%, transparent)")
})
