import { laneAlpha } from "../lib/lanes"

/**
 * Quiet background accent: two lane-coloured radial glows plus feTurbulence grain.
 * Only for headers, empty states and sign-in. Never place it behind data.
 */
export function NoiseBackdrop({
  lanes = [0, 1],
  intensity = 0.18,
  className = "",
  placement = "top",
  animated = false,
}: {
  lanes?: [number, number]
  intensity?: number
  className?: string
  placement?: "top" | "left" | "center"
  /** slow drift of the glows (off under reduced motion); the grain itself stays still */
  animated?: boolean
}) {
  const [a, b] = lanes
  const pos = {
    top: ["12% -10%", "88% -30%"],
    left: ["-10% 20%", "30% 110%"],
    center: ["30% 10%", "75% 90%"],
  }[placement]
  return (
    <div aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}>
      <div
        className={animated ? "drift absolute -inset-[12%]" : "absolute inset-0"}
        style={{
          background:
            `radial-gradient(60% 70% at ${pos[0]}, ${laneAlpha(a, intensity)}, transparent 70%),` +
            `radial-gradient(50% 60% at ${pos[1]}, ${laneAlpha(b, intensity * 0.85)}, transparent 70%)`,
        }}
      />
      <div className="grain absolute inset-0" />
    </div>
  )
}
