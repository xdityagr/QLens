import { describe, expect, it } from "vitest"
import { reconcilePresence, type Present } from "./presence"

const key = (s: string) => s
const live = (...keys: string[]): Present<string>[] => keys.map((k) => ({ key: k, item: k, leaving: false }))

describe("reconcilePresence", () => {
  it("shows the new list as is when nothing was rendered before", () => {
    expect(reconcilePresence([], ["a", "b"], key)).toEqual(live("a", "b"))
  })

  it("keeps a removed item where it was, marked as leaving", () => {
    expect(reconcilePresence(live("a", "b", "c"), ["a", "c"], key)).toEqual([
      { key: "a", item: "a", leaving: false },
      { key: "b", item: "b", leaving: true },
      { key: "c", item: "c", leaving: false },
    ])
  })

  it("keeps a removed first item at the top", () => {
    expect(reconcilePresence(live("a", "b"), ["b"], key).map((p) => [p.key, p.leaving])).toEqual([
      ["a", true],
      ["b", false],
    ])
  })

  it("brings a leaving item back when it reappears, with the fresh value", () => {
    const prev: Present<{ id: string; v: number }>[] = [
      { key: "a", item: { id: "a", v: 1 }, leaving: true },
      { key: "b", item: { id: "b", v: 1 }, leaving: false },
    ]
    const next = reconcilePresence(prev, [{ id: "a", v: 2 }, { id: "b", v: 2 }], (x) => x.id)
    expect(next).toEqual([
      { key: "a", item: { id: "a", v: 2 }, leaving: false },
      { key: "b", item: { id: "b", v: 2 }, leaving: false },
    ])
  })

  it("adds new items in the new list's order", () => {
    expect(reconcilePresence(live("a"), ["z", "a", "b"], key).map((p) => p.key)).toEqual(["z", "a", "b"])
  })
})
