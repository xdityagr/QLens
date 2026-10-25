import { describe, expect, it } from "vitest"
import { sparkPath } from "./sparkline"

describe("sparkPath", () => {
  it("rises from bottom-left to top-right for increasing values", () => {
    const d = sparkPath([1, 2, 3], 100, 20)
    expect(d.startsWith("M0,20")).toBe(true)
    expect(d.endsWith("100,0")).toBe(true)
    expect(d).toBe("M0,20 L50,10 L100,0")
  })

  it("draws a flat line at mid-height for a single value", () => {
    expect(sparkPath([5], 100, 20)).toBe("M0,10 L100,10")
  })

  it("draws a flat line at mid-height when every value is equal", () => {
    expect(sparkPath([3, 3, 3], 100, 20)).toBe("M0,10 L50,10 L100,10")
  })

  it("returns an empty path for no values", () => {
    expect(sparkPath([], 100, 20)).toBe("")
  })

  it("keeps two decimals at most", () => {
    expect(sparkPath([0, 1, 3], 100, 20)).toBe("M0,20 L50,13.33 L100,0")
  })

  it("puts a falling series high on the left", () => {
    expect(sparkPath([4, 2], 10, 10)).toBe("M0,0 L10,10")
  })
})
