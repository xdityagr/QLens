import { Link } from "react-router"

/** A tiny commit graph: one lane branching off another. */
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M6 4.5v11" stroke="var(--lane-0)" strokeWidth="2" strokeLinecap="round" />
      <path d="M6 12.5c0-3.5 8-2.5 8-7" stroke="var(--lane-1)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="6" cy="15.5" r="2.6" fill="var(--lane-0)" />
      <circle cx="6" cy="4.5" r="2.6" fill="var(--bg)" stroke="var(--lane-0)" strokeWidth="2" />
      <circle cx="14" cy="5" r="2.6" fill="var(--lane-1)" />
    </svg>
  )
}

export function Wordmark({ to = "/" }: { to?: string }) {
  return (
    <Link
      to={to}
      className="flex items-center gap-2 rounded-control text-[16px] font-semibold tracking-[-0.03em] text-text"
    >
      <Mark />
      QLens
    </Link>
  )
}
