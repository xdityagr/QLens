import { ServerOff } from "lucide-react"
import { Fragment, type ReactNode } from "react"
import { EmptyState } from "../../components/EmptyState"
import type { ColumnIndex } from "./util"

/** Original header first, identifier as a quiet mono sub-label. */
export function ColLabel({ name, cols, inline = false }: { name: string; cols: ColumnIndex; inline?: boolean }) {
  const label = cols.get(name)?.label
  if (!label || label === name) return <span className="font-mono text-[0.92em]">{name}</span>
  if (inline)
    return (
      <span>
        {label} <span className="font-mono text-[0.84em] text-faint">{name}</span>
      </span>
    )
  return (
    <span className="flex min-w-0 flex-col leading-tight">
      <span className="truncate">{label}</span>
      <span className="truncate font-mono text-[11.5px] text-faint">{name}</span>
    </span>
  )
}

/**
 * A cell value as it really is: doubled spaces and edge spaces are the usual reason two
 * spellings differ, so they're shown as tinted gaps instead of collapsing away.
 */
export function Value({ v }: { v: string | number | boolean | null }) {
  if (v === null) return <span className="text-faint">NULL</span>
  const s = String(v)
  if (s === "") return <span className="text-faint">(empty)</span>
  const parts = s.split(/(^ +| {2,}| +$)/)
  return (
    <span className="whitespace-pre">
      {parts.map((p, i) =>
        // split() with a capture group puts the matched runs at odd indexes
        i % 2 === 1 && p ? (
          <span
            key={i}
            title={`${p.length} space${p.length > 1 ? "s" : ""}`}
            className="rounded-[2px] bg-[color-mix(in_oklab,var(--lane-3)_16%,transparent)] shadow-[inset_0_-1.5px_0_color-mix(in_oklab,var(--lane-3)_70%,transparent)]"
          >
            {p}
          </span>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </span>
  )
}

export function SectionHeading({
  id,
  title,
  count,
  children,
  aside,
}: {
  id?: string
  title: string
  count?: number
  children?: ReactNode
  aside?: ReactNode
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h3 id={id} className="flex items-baseline gap-2.5 text-[19px] font-medium tracking-[-0.02em] text-text">
          {title}
          {count !== undefined && <span className="num text-[13px] font-normal text-faint">{count}</span>}
        </h3>
        {children && <p className="mt-1 max-w-[70ch] text-[14px] leading-relaxed text-muted">{children}</p>}
      </div>
      {aside}
    </div>
  )
}

/** Honest stand-in when the page runs on `npm run dev:mock`, which fakes only auth and workspaces. */
export function MockGap() {
  return (
    <EmptyState icon={<ServerOff size={18} strokeWidth={1.5} />} title="Needs the real backend" lanes={[0, 1]}>
      The mock API only fakes sign-in and workspaces. Start the backend and run <code>npm run dev</code> to import and
      analyze sheets.
    </EmptyState>
  )
}

/** Inline error line under an action. */
export function ActionError({ error }: { error: unknown }) {
  if (!error) return null
  const msg = error instanceof Error ? error.message : "Something went wrong."
  return (
    <p role="alert" className="text-[13px] text-danger">
      {msg}
    </p>
  )
}
