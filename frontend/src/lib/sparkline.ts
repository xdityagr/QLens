const r2 = (n: number) => String(Math.round(n * 100) / 100)

/**
 * SVG path for a sparkline filling a w×h box: x spread evenly, the smallest value at the bottom (y = h),
 * the largest at the top (y = 0). One value, or all equal, draws a flat line at mid-height.
 */
export function sparkPath(values: number[], w: number, h: number): string {
  if (values.length === 0) return ""
  if (values.length === 1) return `M0,${r2(h / 2)} L${r2(w)},${r2(h / 2)}`
  const min = Math.min(...values)
  const span = Math.max(...values) - min
  const step = w / (values.length - 1)
  return values
    .map((v, i) => {
      const y = span === 0 ? h / 2 : h - ((v - min) / span) * h
      return `${i === 0 ? "M" : "L"}${r2(i * step)},${r2(y)}`
    })
    .join(" ")
}
