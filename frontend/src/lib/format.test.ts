import { expect, test } from "vitest"
import { fmtInt, fmtMs } from "./format"

test("fmtMs", () => {
  expect(fmtMs(0.4213)).toBe("0.42 ms")
  expect(fmtMs(12.34)).toBe("12.3 ms")
  expect(fmtMs(1240)).toBe("1.24 s")
})

test("fmtInt uses Indian grouping", () => {
  expect(fmtInt(100000)).toBe("1,00,000")
  expect(fmtInt(3000)).toBe("3,000")
  expect(fmtInt(0)).toBe("0")
})
