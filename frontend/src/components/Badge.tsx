import type { ReactNode } from "react"
import { laneAlpha, laneVar } from "../lib/lanes"

/** Pill with an optional lane dot. `lane` null renders a neutral, hollow dot. */
export function Badge({
  lane,
  children,
  className = "",
}: {
  lane?: number | null
  children: ReactNode
  className?: string
}) {
  const tinted = lane !== undefined && lane !== null
  return (
    <span
      className={
        "inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium leading-none " +
        className
      }
      style={
        tinted
          ? { borderColor: laneAlpha(lane, 0.32), background: laneAlpha(lane, 0.1), color: laneVar(lane) }
          : { borderColor: "var(--border-strong)", color: "var(--muted)" }
      }
    >
      {lane !== undefined && (
        <span
          aria-hidden
          className="size-1.5 rounded-full"
          style={tinted ? { background: laneVar(lane) } : { boxShadow: "inset 0 0 0 1.25px var(--muted)" }}
        />
      )}
      {children}
    </span>
  )
}
