import { ChevronRight } from "lucide-react"
import { useMemo, useState } from "react"
import { Button } from "../../components/Button"
import { analysisApi } from "../../lib/api"
import { fmtInt } from "../../lib/format"
import { usePresence } from "./hooks"
import type { DuplicateGroupOut } from "../../lib/types"
import { ActionError, ChoiceChip, ColLabel, Value } from "./bits"
import type { ColumnIndex } from "./util"
import { useCleanup } from "./queries"

/** Near-duplicate groups, one dense row each; merged or dismissed rows slide out into "Resolved". */
export function DuplicateIssues({
  wsId,
  groups,
  cols,
  busy,
}: {
  wsId: number
  groups: DuplicateGroupOut[]
  cols: ColumnIndex
  busy: boolean
}) {
  const pending = useMemo(() => groups.filter((g) => g.status === "pending"), [groups])
  const resolved = groups.filter((g) => g.status !== "pending")
  // Keyed by content: every cleanup re-runs the analysis, which issues fresh group ids.
  const shown = usePresence(pending, (g) => JSON.stringify([g.column, g.canonical_value]))
  const [showResolved, setShowResolved] = useState(false)

  return (
    <div>
      {shown.length === 0 ? (
        <p className="px-4 py-4 text-[13.5px] text-muted sm:px-5">
          {groups.length === 0
            ? "No text column has values that differ only by case, spacing or a near-miss spelling."
            : "Nothing left to review here."}
        </p>
      ) : (
        <ul className="pb-1.5">
          {shown.map((p, i) => {
            // a quiet column heading whenever the column changes, instead of repeating it on every row
            const heading = i === 0 || shown[i - 1].item.column !== p.item.column
            return (
              <li key={p.key} className={p.leaving ? "anim-leave" : "anim-enter"}>
                {heading && (
                  <div className={`px-4 pb-1 pt-3 text-[12.5px] text-muted @md:px-5 ${i > 0 ? "mt-1.5 border-t border-border" : ""}`}>
                    <ColLabel name={p.item.column} cols={cols} inline />
                  </div>
                )}
                <DuplicateRow wsId={wsId} group={p.item} busy={busy || p.leaving} />
              </li>
            )
          })}
        </ul>
      )}

      {resolved.length > 0 && (
        <div className="border-t border-border px-2 py-1.5 sm:px-3">
          <button
            type="button"
            onClick={() => setShowResolved((v) => !v)}
            aria-expanded={showResolved}
            className="flex h-8 items-center gap-1.5 rounded-control px-2 text-[13px] text-muted transition-colors hover:text-text"
          >
            <ChevronRight size={14} className={`transition-transform duration-200 ${showResolved ? "rotate-90" : ""}`} />
            Resolved <span className="num text-faint">{resolved.length}</span>
          </button>
          {showResolved && (
            <ul className="anim-enter mb-1.5 flex flex-col">
              {resolved.map((g) => (
                <li key={g.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-2 py-1.5 text-[13px]">
                  <span className="w-[4.5rem] shrink-0 text-faint">{g.status === "merged" ? "Merged" : "Dismissed"}</span>
                  <span className="text-muted">{cols.get(g.column)?.label ?? g.column}</span>
                  <span className="min-w-0 font-mono text-[12.5px] text-text">
                    {g.status === "merged" ? (
                      <>
                        <span className="font-sans text-faint">into </span>
                        <Value v={g.canonical_value} />
                      </>
                    ) : (
                      g.values.map((v, i) => (
                        <span key={i}>
                          {i > 0 && <span className="text-faint">, </span>}
                          <Value v={v.value} />
                        </span>
                      ))
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function DuplicateRow({ wsId, group, busy }: { wsId: number; group: DuplicateGroupOut; busy: boolean }) {
  const [canonical, setCanonical] = useState(group.canonical_value)
  const [touched, setTouched] = useState(false)
  const merge = useCleanup(wsId, (c: string | undefined) => analysisApi.merge(wsId, group.id, c))
  const dismiss = useCleanup(wsId, () => analysisApi.dismiss(wsId, group.id))
  const similar = group.confidence === "similar"
  const changes = group.values.filter((v) => v.value !== canonical).reduce((n, v) => n + v.rows, 0)
  const disabled = busy || merge.isPending || dismiss.isPending

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-1.5 @md:px-5">
      <fieldset disabled={disabled} className="flex min-w-0 flex-wrap items-center gap-1.5">
        <legend className="sr-only">Keep which spelling?</legend>
        {group.values.map((v) => (
          <ChoiceChip
            key={v.value}
            name={`dup-${group.id}`}
            value={v.value}
            rows={v.rows}
            checked={v.value === canonical}
            animate={touched}
            onPick={() => {
              setCanonical(v.value)
              setTouched(true)
            }}
          />
        ))}
        {similar && (
          // only near-miss spellings get a note: they need a human look, case/spacing ones don't
          <span className="ml-1 rounded-full border border-dashed border-[color-mix(in_oklab,var(--lane-3)_50%,transparent)] px-2 py-0.5 text-[11.5px] text-lane-3">
            Similar spelling
            {group.max_similarity !== null && (
              <>
                , <span className="num">{Math.round(group.max_similarity * 100)}%</span> alike
              </>
            )}
          </span>
        )}
      </fieldset>

      <div className="ml-auto flex items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          loading={dismiss.isPending}
          disabled={disabled}
          onClick={() => dismiss.mutate(undefined)}
        >
          Dismiss
        </Button>
        <Button
          size="sm"
          variant="primary"
          loading={merge.isPending}
          disabled={disabled || changes === 0}
          title={changes ? `Rewrites ${changes} ${changes === 1 ? "row" : "rows"} to “${canonical}”` : undefined}
          onClick={() => merge.mutate(canonical === group.canonical_value ? undefined : canonical)}
        >
          Merge <span className="num">{fmtInt(changes)}</span> {changes === 1 ? "row" : "rows"}
        </Button>
      </div>
      {(merge.error || dismiss.error) && (
        <div className="w-full">
          <ActionError error={merge.error ?? dismiss.error} />
        </div>
      )}
    </div>
  )
}
