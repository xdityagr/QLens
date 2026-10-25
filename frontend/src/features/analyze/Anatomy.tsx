import { KeyRound } from "lucide-react"
import { Component, lazy, Suspense, type ReactNode } from "react"
import type { Anatomy, AnatomyEdge } from "../../lib/anatomy"
import { SectionHeading } from "./bits"
import { ColumnCard } from "./ColumnCard"
import { KEY_COLOR, type ColumnIndex } from "./util"

// React Flow and dagre load with the diagram, not with the rest of the app.
const AnatomyDiagram = lazy(() => import("./AnatomyDiagram"))

/** A failed chunk load must not take the whole page down. */
class DiagramBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (this.state.failed)
      return <p className="px-5 py-6 text-[14px] text-muted">The diagram failed to load — reload the page.</p>
    return this.props.children
  }
}

/**
 * Sheet anatomy: the row identity first, then how columns determine each other, then the columns
 * nothing else determines.
 */
export function AnatomySection({
  anatomy,
  cols,
  derivedCount,
  showDerived,
  onShowDerived,
  selected,
  onSelect,
  onEdgeActivate,
}: {
  anatomy: Anatomy
  cols: ColumnIndex
  derivedCount: number
  showDerived: boolean
  onShowDerived: (v: boolean) => void
  selected: string | null
  onSelect: (name: string | null) => void
  onEdgeActivate: (e: AnatomyEdge) => void
}) {
  const hasEdges = anatomy.edges.length > 0
  const hasApprox = anatomy.edges.some((e) => e.kind === "approx")
  const hasDerived = anatomy.edges.some((e) => e.derived)

  return (
    <section aria-labelledby="anat-h">
      <SectionHeading id="anat-h" title="Sheet structure">
        Each arrow reads “determines”: one value on the left always comes with one value on the right. Select a
        column to trace its rules.
      </SectionHeading>

      <div className="rounded-card border border-border bg-surface">
        <KeyBanner anatomy={anatomy} cols={cols} />

        {hasEdges ? (
          <div className="border-t border-border">
            <DiagramBoundary>
              <Suspense fallback={<div className="h-[300px]" />}>
              <AnatomyDiagram
                  anatomy={anatomy}
                  selected={selected}
                  onSelect={onSelect}
                  onEdgeActivate={onEdgeActivate}
                />
  </Suspense>
            </DiagramBoundary>
          </div>
        ) : (
          <p className="border-t border-border px-5 py-6 text-[14px] text-muted">
            No column determines another, so there is nothing to draw. Every column varies on its own in this sheet.
          </p>
        )}

        <div className="flex flex-col gap-4 border-t border-border px-4 py-4 sm:px-5">
          {anatomy.loose.length > 0 && (
            <div>
              <p className="mb-2.5 text-[13px] text-muted">
                {hasEdges ? "Not determined by another column" : "Columns"}
              </p>
              <ul className="flex flex-wrap gap-2.5">
                {anatomy.loose.map((c) => (
                  <li key={c.name}>
                    <ColumnCard col={c} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {hasEdges && (
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 text-[12.5px] text-muted">
              <ul className="flex flex-wrap items-center gap-x-5 gap-y-2" aria-label="Legend">
                <LegendItem stroke="var(--muted)">Exact</LegendItem>
                {hasApprox && (
                  <LegendItem stroke="var(--lane-3)" dash="5 4">
                    Approximate
                  </LegendItem>
                )}
                {hasDerived && (
                  <LegendItem stroke="var(--muted)" dash="1.5 4.5" round>
                    Derived
                  </LegendItem>
                )}
                <li className="flex items-center gap-2">
                  <KeyRound size={13} strokeWidth={2} style={{ color: KEY_COLOR }} aria-hidden />
                  Row identity
                </li>
              </ul>
              {derivedCount > 0 && (
                <DerivedToggle checked={showDerived} onChange={onShowDerived} count={derivedCount} />
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function KeyBanner({ anatomy, cols }: { anatomy: Anatomy; cols: ColumnIndex }) {
  const { primaryKey, alternateKeys } = anatomy
  const label = (n: string) => cols.get(n)?.label ?? n
  if (!primaryKey)
    return (
      <div className="flex items-center gap-3 px-4 py-4 sm:px-5">
        <KeyIcon muted />
        <p className="text-[14px] text-muted">
          No set of up to three columns is unique on every row, so the sheet has no natural row identity.
        </p>
      </div>
    )
  return (
    <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="flex min-w-0 items-center gap-3.5">
        <KeyIcon />
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[15px] font-medium tracking-[-0.01em] text-text">
            <span className="mr-1">Row identity</span>
            {primaryKey.map((n, i) => (
              <span key={n} className="flex items-center gap-2">
                {i > 0 && <span className="font-mono text-[13px] font-normal text-faint">+</span>}
                <span
                  className="rounded-[6px] px-2 py-0.5 text-[14px]"
                  style={{
                    background: `color-mix(in oklab, ${KEY_COLOR} 12%, transparent)`,
                    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${KEY_COLOR} 38%, transparent)`,
                  }}
                >
                  {label(n)}
                </span>
              </span>
            ))}
          </p>
          <p className="mt-1 text-[13px] text-muted">
            No two rows share the same {primaryKey.map(label).join(" and ")}.
          </p>
        </div>
      </div>
      {alternateKeys.length > 0 && (
        <div className="text-[13px] text-muted sm:max-w-[45%] sm:text-right">
          <span>Also unique </span>
          {alternateKeys.map((k, ki) => (
            <span key={k.join(",")} className="text-text">
              {ki > 0 && <span className="text-faint">, </span>}
              {k.map((n, i) => (
                <span key={n}>
                  {i > 0 && <span className="font-mono text-faint"> + </span>}
                  {label(n)}
                </span>
              ))}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function KeyIcon({ muted = false }: { muted?: boolean }) {
  return (
    <span
      aria-hidden
      className="grid size-9 shrink-0 place-items-center rounded-full"
      style={{
        background: muted ? "var(--raised)" : `color-mix(in oklab, ${KEY_COLOR} 14%, transparent)`,
        color: muted ? "var(--faint)" : KEY_COLOR,
      }}
    >
      <KeyRound size={16} strokeWidth={2} />
    </span>
  )
}

function LegendItem({
  stroke,
  dash,
  round,
  children,
}: {
  stroke: string
  dash?: string
  round?: boolean
  children: string
}) {
  return (
    <li className="flex items-center gap-2">
      <svg width="26" height="8" aria-hidden className="overflow-visible">
        <line
          x1="0"
          y1="4"
          x2="20"
          y2="4"
          stroke={stroke}
          strokeWidth="1.6"
          strokeDasharray={dash}
          strokeLinecap={round ? "round" : "butt"}
        />
        <path d="M26,4 L18,0 L19.6,4 L18,8 Z" fill={stroke} />
      </svg>
      {children}
    </li>
  )
}

export function DerivedToggle({
  checked,
  onChange,
  count,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  count: number
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-[13px] text-muted select-none hover:text-text">
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span
        aria-hidden
        className="relative h-[18px] w-[30px] rounded-full bg-border-strong transition-colors peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent after:absolute after:left-[3px] after:top-[3px] after:size-3 after:rounded-full after:bg-bg after:transition-transform after:duration-200 peer-checked:after:translate-x-3"
      />
      <span>
        Show derived rules (<span className="num">{count}</span>)
      </span>
    </label>
  )
}
