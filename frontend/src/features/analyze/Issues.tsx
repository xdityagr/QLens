import { ChevronRight } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"
import { inconsistencyEntries } from "../../lib/analysis"
import { usePrefersReducedMotion } from "./hooks"
import type { AnalysisOut } from "../../lib/types"
import { DuplicateIssues } from "./DuplicateIssues"
import { InconsistencyIssues } from "./InconsistencyIssues"
import { issueId, type ColumnIndex } from "./util"

/** Both kinds of cleanup in one compact, collapsible panel. */
export function IssuesPanel({
  wsId,
  a,
  cols,
  busy,
  focus,
}: {
  wsId: number
  a: AnalysisOut
  cols: ColumnIndex
  busy: boolean
  /** a request (from the diagram) to open and show one inconsistency */
  focus: { fdId: number; n: number } | null
}) {
  const [dupsOpen, setDupsOpen] = useState(true)
  const [incOpen, setIncOpen] = useState(true)
  const reduced = usePrefersReducedMotion()
  const dupCount = a.duplicates.filter((d) => d.status === "pending").length
  const incCount = inconsistencyEntries(a.fds, a.inconsistencies).length

  // Open the section if needed, then bring the rule into view once it is rendered.
  const [lastFocus, setLastFocus] = useState(focus)
  if (focus !== lastFocus) {
    setLastFocus(focus)
    if (focus) setIncOpen(true)
  }
  useEffect(() => {
    if (!focus) return
    const el = document.getElementById(issueId(focus.fdId))
    if (!el) return
    el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" })
    el.focus({ preventScroll: true })
  }, [focus, reduced])

  return (
    <section aria-labelledby="issues-h" className="@container">
      <h3 id="issues-h" className="mb-3 flex items-baseline gap-2.5 text-[19px] font-medium tracking-[-0.02em] text-text">
        Issues
        <span className="num text-[13px] font-normal text-faint">{dupCount + incCount}</span>
      </h3>
      <div className="overflow-hidden rounded-card border border-border bg-surface">
        <Group
          title="Near-duplicates"
          count={dupCount}
          hint="The same value typed more than one way. Merging rewrites the others to the spelling you pick."
          open={dupsOpen}
          onToggle={() => setDupsOpen((v) => !v)}
        >
          <DuplicateIssues wsId={wsId} groups={a.duplicates} cols={cols} busy={busy} />
        </Group>
        <div className="border-t border-border">
          <Group
            title="Inconsistencies"
            count={incCount}
            hint="Rules that hold on almost every row. The suggestion is the value most rows use; pick another if it's wrong."
            open={incOpen}
            onToggle={() => setIncOpen((v) => !v)}
          >
            <InconsistencyIssues
              wsId={wsId}
              items={a.inconsistencies}
              fds={a.fds}
              cols={cols}
              busy={busy}
              flash={focus}
            />
          </Group>
        </div>
      </div>
    </section>
  )
}

function Group({
  title,
  count,
  hint,
  open,
  onToggle,
  children,
}: {
  title: string
  count: number
  hint: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="group flex w-full items-start gap-2.5 px-4 py-3 text-left transition-colors hover:bg-hover @md:px-5"
      >
        <ChevronRight
          size={15}
          className={`mt-[3px] shrink-0 text-muted transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        />
        <span className="min-w-0">
          <span className="flex items-baseline gap-2 text-[14.5px] font-medium text-text">
            {title}
            <span
              className={`num rounded-full px-1.5 text-[11.5px] ${count ? "bg-[color-mix(in_oklab,var(--lane-3)_14%,transparent)] text-lane-3" : "text-faint"}`}
            >
              {count}
            </span>
          </span>
          <span className="mt-0.5 block text-[12.5px] leading-snug text-muted">{hint}</span>
        </span>
      </button>
      {open && <div className="anim-enter border-t border-border">{children}</div>}
    </div>
  )
}
