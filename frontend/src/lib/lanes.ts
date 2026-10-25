// GitLens-style lane palette. Index 0 is the accent; a generated table keeps its
// color_index lane everywhere it appears, so callers pass that index straight in.
export const LANE_COUNT = 8

export function laneVar(index: number): string {
  const i = ((Math.trunc(index) % LANE_COUNT) + LANE_COUNT) % LANE_COUNT
  return `var(--lane-${i})`
}

export function laneAlpha(index: number, alpha: number): string {
  const pct = Math.round(Math.min(1, Math.max(0, alpha)) * 100)
  return `color-mix(in oklab, ${laneVar(index)} ${pct}%, transparent)`
}
