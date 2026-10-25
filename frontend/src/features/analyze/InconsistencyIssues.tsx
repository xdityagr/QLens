import { useMemo, useState } from "react"
import { Button } from "../../components/Button"
import { conflictKey, inconsistencyEntries, type InconsistencyEntry } from "../../lib/analysis"
import { analysisApi } from "../../lib/api"
import { fmtInt } from "../../lib/format"
import { usePresence } from "./hooks"
import type { FDOut, InconsistencyOut } from "../../lib/types"
import { ActionError, ChoiceChip, Value } from "./bits"
import { issueId, type ColumnIndex } from "./util"
import { useCleanup } from "./queries"

// The backend lists at most this many conflicting groups per dependency (the fix covers all of them).
const LIST_LIMIT = 20

/** One block per accepted approximate rule: the rule, a Fix button, then one row per conflicting value. */
export function InconsistencyIssues({
  wsId,
  items,
  fds,
  cols,
  busy,
  flash,
}: {
  wsId: number
  items: InconsistencyOut[]
  fds: FDOut[]
  cols: ColumnIndex
  busy: boolean
  /** fd id to highlight briefly (from a click on the diagram) */
  flash: { fdId: number; n: number } | null
}) {
  const entries = useMemo(() => inconsistencyEntries(fds, items), [fds, items])
  // Keyed by the rule itself: every cleanup re-runs the analysis, which issues fresh fd ids.
  const shown = usePresence(entries, (e) => {
    const lhs = e.fd?.lhs ?? e.item?.lhs ?? []
    return `${JSON.stringify(lhs)}->${e.fd?.rhs ?? e.item?.rhs}`
  })

  if (shown.length === 0)
    return <p className="px-4 py-4 text-[13.5px] text-muted sm:px-5">Every accepted rule holds on every row.</p>
  return (
    <ul className="divide-y divide-border">
      {shown.map((p) => (
        <li
          key={p.key}
          id={issueId(p.item.fdId)}
          tabIndex={-1}
          className={(p.leaving ? "anim-leave" : "anim-enter") + " outline-none"}
        >
          <div
            key={flash && flash.fdId === p.item.fdId ? flash.n : 0}
            className={flash?.fdId === p.item.fdId ? "anim-flash" : undefined}
          >
            <Inconsistency wsId={wsId} entry={p.item} cols={cols} busy={busy || p.leaving} />
          </div>
        </li>
      ))}
    </ul>
  )
}

function Inconsistency({
  wsId,
  entry,
  cols,
  busy,
}: {
  wsId: number
  entry: InconsistencyEntry
  cols: ColumnIndex
  busy: boolean
}) {
  const { fdId, fd, item } = entry
  // conflictKey(lhs_values) -> chosen value, only where it differs from the suggestion
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [touched, setTouched] = useState(false)
  const fix = useCleanup(wsId, (o: Record<string, string>) => analysisApi.fix(wsId, fdId, o))
  const conflicts = item?.conflicts ?? []
  const truncated = conflicts.length >= LIST_LIMIT

  const chosen = (c: InconsistencyOut["conflicts"][number]) => overrides[conflictKey(c.lhs_values)] ?? c.suggested
  const listedChanges = conflicts.reduce(
    (n, c) => n + c.variants.filter((v) => v.value !== chosen(c)).reduce((m, v) => m + v.rows, 0),
    0,
  )
  // Past the listed groups we can only go by the dependency's own count.
  const changes =
    fd && (truncated || conflicts.length === 0) ? Math.max(fd.violating_rows, listedChanges) : listedChanges
  const disabled = busy || fix.isPending
  const lhs = item?.lhs ?? fd?.lhs ?? []
  const lhsLabel = lhs.map((n) => cols.get(n)?.label ?? n).join(" + ")

  return (
    <div className="px-4 py-3 @md:px-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="flex min-w-0 items-start gap-2.5 text-[13.5px] font-medium leading-snug text-text">
          <svg width="14" height="14" aria-hidden className="mt-[3px] shrink-0">
            <line x1="1" y1="7" x2="13" y2="7" stroke="var(--lane-3)" strokeWidth="1.8" strokeDasharray="4 3" />
          </svg>
          <span className="min-w-0">{item?.sentence ?? fd?.sentence}</span>
        </p>
        <Button
          size="sm"
          variant="primary"
          loading={fix.isPending}
          disabled={disabled || changes === 0}
          onClick={() => fix.mutate(overrides)}
        >
          Fix <span className="num">{fmtInt(changes)}</span> {changes === 1 ? "row" : "rows"}
        </Button>
      </div>

      {item && conflicts.length > 0 ? (
        <div className="mt-2.5 ml-[23px] flex flex-col gap-1.5">
          {conflicts.map((c) => {
            const key = conflictKey(c.lhs_values)
            const pick = chosen(c)
            return (
              <div key={key} className="grid gap-x-4 gap-y-1.5 @md:grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)] @md:items-center">
                <div className="truncate font-mono text-[12.5px] text-muted" title={lhsLabel}>
                  {c.lhs_values.map((v, i) => (
                    <span key={i}>
                      {i > 0 && <span className="text-faint"> + </span>}
                      <Value v={v} />
                    </span>
                  ))}
                </div>
                <fieldset disabled={disabled} className="flex min-w-0 flex-wrap gap-1.5">
                  <legend className="sr-only">
                    Value of {cols.get(item.rhs)?.label ?? item.rhs} to keep for {lhsLabel}
                  </legend>
                  {c.variants.map((v) => {
                    const suggested = v.value === c.suggested
                    // The fix endpoint takes text overrides only, so NULL can be kept but not chosen.
                    const unpickable = v.value === null && !suggested
                    return (
                      <ChoiceChip
                        key={v.value ?? "(null)"}
                        name={`fix-${fdId}-${key}`}
                        value={v.value}
                        rows={v.rows}
                        checked={v.value === pick}
                        tone="good"
                        strike
                        animate={touched}
                        disabled={unpickable}
                        title={unpickable ? "An empty value can't be chosen as the fix" : undefined}
                        note={suggested ? <span className="font-sans text-[11px] text-lane-4">suggested</span> : null}
                        onPick={() => {
                          setTouched(true)
                          setOverrides((o) => {
                            const next = { ...o }
                            if (v.value === c.suggested || v.value === null) delete next[key]
                            else next[key] = v.value
                            return next
                          })
                        }}
                      />
                    )
                  })}
                </fieldset>
              </div>
            )
          })}
          {truncated && (
            <p className="text-[12.5px] text-muted">
              Showing the first {LIST_LIMIT} groups. The fix also covers the rest, using each one's suggestion.
            </p>
          )}
        </div>
      ) : (
        <p className="mt-1.5 ml-[23px] text-[13px] text-muted">
          The disagreeing rows aren't listed for this rule. Fixing sets each one to the value most rows with the same{" "}
          {lhsLabel || "key"} have.
        </p>
      )}
      {fix.error && (
        <div className="mt-2 ml-[23px]">
          <ActionError error={fix.error} />
        </div>
      )}
    </div>
  )
}
