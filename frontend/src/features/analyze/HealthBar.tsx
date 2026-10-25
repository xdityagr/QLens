import { Check, CheckCheck } from "lucide-react"
import { useState } from "react"
import { Button } from "../../components/Button"
import { Dialog } from "../../components/Dialog"
import { healthSummary } from "../../lib/analysis"
import { fmtInt } from "../../lib/format"
import type { AnalysisOut } from "../../lib/types"
import { ActionError } from "./bits"
import { useTweenedCount } from "./hooks"

/** One slim line: how many issues are open, and the shortcut that clears the safe ones. */
export function HealthBar({
  a,
  busy,
  pending,
  error,
  onAcceptAll,
}: {
  a: AnalysisOut
  busy: boolean
  pending: boolean
  error: unknown
  onAcceptAll: () => void
}) {
  const h = healthSummary(a)
  const [confirming, setConfirming] = useState(false)
  const shownIssues = useTweenedCount(h.issues)
  const clean = h.issues === 0
  const pendingDups = a.duplicates.filter((d) => d.status === "pending")
  const sameDups = pendingDups.filter((d) => d.confidence === "same_normalized").length
  const similarDups = pendingDups.length - sameDups
  const approx = h.issues - h.duplicates
  const tone = clean ? "var(--lane-4)" : "var(--lane-3)"

  return (
    <div
      className="rounded-card border bg-surface transition-[border-color] duration-300"
      style={{ borderColor: `color-mix(in oklab, ${tone} ${clean ? 30 : 22}%, var(--border))` }}
    >
      <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="relative grid size-7 shrink-0 place-items-center rounded-full transition-colors duration-300"
            style={{ background: `color-mix(in oklab, ${tone} 15%, transparent)`, color: tone }}
          >
            {clean ? (
              <Check key="ok" size={14} strokeWidth={2.75} className="anim-tick" />
            ) : (
              <span className="size-2 rounded-full" style={{ background: tone }} />
            )}
          </span>
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-0.5 text-[13.5px] text-muted">
            <span className="sr-only" aria-live="polite">
              {clean ? "No open issues" : `${h.issues} ${h.issues === 1 ? "issue" : "issues"} to review`}
            </span>
            <span className="text-[15px] font-medium tracking-[-0.01em] text-text">
              {clean ? (
                "No open issues"
              ) : (
                <>
                  <span className="num">{fmtInt(shownIssues)}</span> {h.issues === 1 ? "issue" : "issues"} to review
                </>
              )}
            </span>
            {clean ? (
              <span>
                Every accepted rule holds on all <span className="num text-text">{fmtInt(a.row_count)}</span> rows.
              </span>
            ) : (
              <>
                {h.duplicates > 0 && (
                  <span>
                    <span className="num text-text">{h.duplicates}</span> near-duplicate{" "}
                    {h.duplicates === 1 ? "group" : "groups"}
                  </span>
                )}
                {approx > 0 && (
                  <span>
                    <span className="num text-text">{approx}</span> {approx === 1 ? "rule" : "rules"} broken by{" "}
                    <span className="num text-text">{fmtInt(h.inconsistentRows)}</span>{" "}
                    {h.inconsistentRows === 1 ? "row" : "rows"}
                  </span>
                )}
              </>
            )}
          </p>
        </div>
        {!clean && (
          <Button
            size="sm"
            icon={<CheckCheck size={14} />}
            loading={pending}
            disabled={busy || (sameDups === 0 && approx === 0)}
            onClick={() => setConfirming(true)}
            className="self-start sm:self-auto"
          >
            Accept all suggestions
          </Button>
        )}
      </div>
      {error ? (
        <div className="border-t border-border px-5 py-2.5">
          <ActionError error={error} />
        </div>
      ) : null}

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Accept all suggestions?"
        description="This edits QLens's working copy of the sheet. Your original upload stays untouched."
      >
        <ul className="flex list-disc flex-col gap-2 pl-5 text-[14px] text-text marker:text-faint">
          {sameDups > 0 && (
            <li>
              Merge <span className="num">{sameDups}</span> near-duplicate {sameDups === 1 ? "group" : "groups"} that
              differ only by case or spacing
            </li>
          )}
          {approx > 0 && (
            <li>
              Rewrite <span className="num">{fmtInt(h.inconsistentRows)}</span> disagreeing{" "}
              {h.inconsistentRows === 1 ? "row" : "rows"} to the suggested values
            </li>
          )}
        </ul>
        {similarDups > 0 && (
          <p className="mt-3 text-[13.5px] text-muted">
            <span className="num">{similarDups}</span> {similarDups === 1 ? "group" : "groups"} with merely similar
            spellings stay for you to check.
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setConfirming(false)
              onAcceptAll()
            }}
          >
            Accept all
          </Button>
        </div>
      </Dialog>
    </div>
  )
}
