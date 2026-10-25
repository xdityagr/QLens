import { describe, expect, test } from "vitest"
import { easeInOutCubic, interpolateLayout, startPositions } from "./layoutMotion"

type N = { id: string; position: { x: number; y: number }; data: { name: string } }
const node = (id: string, name: string, x: number, y: number): N => ({ id, position: { x, y }, data: { name } })

describe("easeInOutCubic", () => {
  test("starts at 0, ends at 1, is symmetric", () => {
    expect(easeInOutCubic(0)).toBe(0)
    expect(easeInOutCubic(1)).toBe(1)
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5)
    expect(easeInOutCubic(0.25) + easeInOutCubic(0.75)).toBeCloseTo(1)
  })
  test("clamps outside 0..1", () => {
    expect(easeInOutCubic(-1)).toBe(0)
    expect(easeInOutCubic(2)).toBe(1)
  })
})

describe("startPositions", () => {
  test("matches by id first", () => {
    const from = startPositions([node("a", "x", 1, 2)], [node("a", "renamed", 9, 9)])
    expect(from.get("a")).toEqual({ x: 1, y: 2 })
  })
  test("falls back to an alias (a rebuilt table keeps its name but gets a new id)", () => {
    const from = startPositions([node("t-1", "students", 5, 6)], [node("t-9", "students", 0, 0)], (n) => n.data.name)
    expect(from.get("t-9")).toEqual({ x: 5, y: 6 })
  })
  test("an alias already claimed by an id match is not reused", () => {
    const prev = [node("t-1", "students", 5, 6)]
    const next = [node("t-1", "learners", 0, 0), node("t-2", "students", 0, 0)]
    const from = startPositions(prev, next, (n) => n.data.name)
    expect(from.get("t-1")).toEqual({ x: 5, y: 6 })
    expect(from.has("t-2")).toBe(false)
  })
  test("new nodes have no start", () => {
    expect(startPositions([], [node("a", "x", 0, 0)]).size).toBe(0)
  })
})

describe("interpolateLayout", () => {
  const next = [node("a", "a", 100, 200), node("b", "b", 50, 50)]
  const from = new Map([["a", { x: 0, y: 0 }]])

  test("t=0 is where nodes were", () => {
    expect(interpolateLayout(from, next, 0)[0].position).toEqual({ x: 0, y: 0 })
  })
  test("t=1 is the new layout", () => {
    expect(interpolateLayout(from, next, 1).map((n) => n.position)).toEqual([
      { x: 100, y: 200 },
      { x: 50, y: 50 },
    ])
  })
  test("halfway is halfway (the easing is symmetric)", () => {
    const p = interpolateLayout(from, next, 0.5)[0].position
    expect(p.x).toBeCloseTo(50)
    expect(p.y).toBeCloseTo(100)
  })
  test("a node without a start stays at its target and keeps its data", () => {
    const out = interpolateLayout(from, next, 0.3)
    expect(out[1].position).toEqual({ x: 50, y: 50 })
    expect(out[1].data).toBe(next[1].data)
  })
  test("does not mutate its inputs", () => {
    interpolateLayout(from, next, 0.5)
    expect(next[0].position).toEqual({ x: 100, y: 200 })
  })
})
