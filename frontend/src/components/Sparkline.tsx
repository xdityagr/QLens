import { sparkPath } from "../lib/sparkline"

/**
 * Tiny line chart of a series (durations of a saved query's runs, oldest first). The last point gets a
 * dot. The line draws in once when it first appears or gains a point (CSS, off under reduced motion).
 */
export function Sparkline({
  values,
  width = 64,
  height = 18,
  color = "var(--accent)",
  label,
  className = "",
}: {
  values: number[]
  width?: number
  height?: number
  color?: string
  /** accessible description; without it the chart is decorative */
  label?: string
  className?: string
}) {
  // inset so the stroke and end dot aren't clipped at the box edges
  const pad = 2.5
  const w = width - pad * 2
  const h = height - pad * 2
  const d = sparkPath(values, w, h)
  if (!d) return <svg width={width} height={height} aria-hidden className={className} />
  const last = d
    .slice(d.lastIndexOf("L") + 1)
    .split(",")
    .map(Number)
  // a new run redraws the line, even once the series is a fixed-length window of recent runs
  const drawKey = `${values.length}:${values[values.length - 1]}`
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={`shrink-0 overflow-visible ${className}`}
    >
      <g transform={`translate(${pad} ${pad})`}>
        <path
          key={drawKey}
          d={d}
          pathLength={1}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="[stroke-dasharray:1] animate-[draw_600ms_cubic-bezier(0.3,0.7,0.2,1)_both]"
        />
        <circle
          cx={last[0]}
          cy={last[1]}
          r={2}
          fill={color}
          className="animate-[fade-in_200ms_ease-out_520ms_both]"
          key={`d${drawKey}`}
        />
      </g>
    </svg>
  )
}
