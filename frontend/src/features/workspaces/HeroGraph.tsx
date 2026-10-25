import { laneVar } from "../../lib/lanes"

/**
 * Faint commit-graph texture for the dashboard hero's empty right side.
 * Pure decoration (aria-hidden), masked so it fades into the canvas.
 */
const LANES: { lane: number; d: string; nodes: [number, number][] }[] = [
  { lane: 0, d: "M100 -10 V430", nodes: [[100, 60], [100, 156], [100, 300]] },
  { lane: 1, d: "M100 156 C100 182 150 178 150 204 V430", nodes: [[150, 252], [150, 396]] },
  { lane: 2, d: "M150 252 C150 278 200 274 200 300 V430", nodes: [[200, 348]] },
  { lane: 3, d: "M250 -10 V430", nodes: [[250, 108], [250, 396]] },
  { lane: 4, d: "M250 108 C250 134 300 130 300 156 V260 C300 286 250 282 250 308", nodes: [[300, 204]] },
  { lane: 5, d: "M350 -10 V430", nodes: [[350, 60], [350, 252]] },
  { lane: 6, d: "M350 300 C350 326 400 322 400 348 V430", nodes: [[400, 396]] },
]

export function HeroGraph({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none ${className}`}
      style={{
        maskImage: "radial-gradient(65% 70% at 50% 42%, #000 30%, transparent 85%)",
        WebkitMaskImage: "radial-gradient(65% 70% at 50% 42%, #000 30%, transparent 85%)",
      }}
    >
      <svg viewBox="0 0 480 420" width="480" height="420" fill="none" className="opacity-70 dark:opacity-65">
        {LANES.map((l) => (
          <path key={l.lane} d={l.d} stroke={laneVar(l.lane)} strokeWidth={1.75} strokeLinecap="round" />
        ))}
        {LANES.flatMap((l) =>
          l.nodes.map(([cx, cy]) => (
            <circle key={`${l.lane}-${cy}`} cx={cx} cy={cy} r={4.5} fill={laneVar(l.lane)} stroke="var(--bg)" strokeWidth={2.5} />
          )),
        )}
      </svg>
    </div>
  )
}
