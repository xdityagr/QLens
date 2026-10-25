import { Check } from "lucide-react"
import { useState } from "react"
import { Badge } from "../../components/Badge"
import { Button } from "../../components/Button"
import { conflictKey } from "../../lib/analysis"
import { analysisApi } from "../../lib/api"
import { fmtInt } from "../../lib/format"
import type { FDOut, InconsistencyOut } from "../../lib/types"
import { ActionError, ColLabel, SectionHeading, Value } from "./bits"
import type { ColumnIndex } from "./util"
import { useCleanup } from "./queries"

// The backend lists at most this many conflicting groups per dependency (the fix covers all of them).
const LIST_LIMIT = 20

export function InconsistenciesSection({
  wsId,
  items,
  fds,
  cols,
  busy,
}: {
  wsId: number
  items: InconsistencyOut[]
  fds: FDOut[]
  cols: ColumnIndex
  busy: boolean
}) {
  // One card per accepted approximate rule. Conflict details come from `items`; if a rule has none
  // listed, its card still says how many rows disagree and can still be fixed.
  const approx = fds.filter((f) => !f.is_exact && f.accepted)
  const entries = [
    ...approx.map((fd) => ({ fdId: fd.id, fd, item: items.find((i) => i.fd_id === fd.id) })),
    ...items
      .filter((i) => !approx.some((f) => f.id === i.fd_id))
      .map((item) => ({
        fdId: item.fd_id,
        fd: fds.find((f) => f.id === item.fd_id),
        item,
      })),
  ]
  return (
    <section aria-labelledby="inc-h">
      <SectionHeading id="inc-h" title="Inconsistencies" count={entries.length}>
        Rules that hold on almost every row. Where a few rows disagree, QLens suggests the value most rows use; pick
        another if it's wrong.
      </SectionHeading>
      {entries.length === 0 ? (
        <p className="rounded-card border border-border bg-surface px-5 py-4 text-[14px] text-muted">
          Every accepted dependency holds on every row.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {entries.map((e) => (
            <Inconsistency key={e.fdId} wsId={wsId} fdId={e.fdId} item={e.item} fd={e.fd} cols={cols} busy={busy} />
          ))}
        </div>
      )}
    </section>
  )
}

function Inconsistency({
  wsId,
  fdId,
  item,
  fd,
  cols,
  busy,
}: {
  wsId: number
  fdId: number
  item: InconsistencyOut | undefined
  fd: FDOut | undefined
  cols: ColumnIndex
  busy: boolean
}) {
  // conflictKey(lhs_values) -> chosen value, only where it differs from the suggestion
  const [overrides, setOverrides] = useState<Record<string, string>>({})
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

  return (
    <article className="rounded-card border border-border bg-surface">
      <header className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4">
        <p className="max-w-[60ch] text-[15px] font-medium leading-snug tracking-[-0.01em] text-text">
          {item?.sentence ?? fd?.sentence}
        </p>
        {fd && (
          <Badge lane={3}>
            <span className="num">{fmtInt(fd.violating_rows)}</span> {fd.violating_rows === 1 ? "row" : "rows"} disagree
          </Badge>
        )}
      </header>

      {item && conflicts.length > 0 ? (
        <div className="scrollbar-thin mt-3.5 overflow-x-auto px-5">
          <table className="w-full border-separate border-spacing-0 text-[13px]">
            <thead>
              <tr className="text-left text-[12px] text-muted">
                {item.lhs.map((n) => (
                  <th key={n} scope="col" className="border-b border-border py-2 pr-6 font-normal">
                    <ColLabel name={n} cols={cols} inline />
                  </th>
                ))}
                <th scope="col" className="w-full border-b border-border py-2 font-normal">
                  <ColLabel name={item.rhs} cols={cols} inline /> values found
                </th>
              </tr>
            </thead>
            <tbody>
              {conflicts.map((c) => {
                const key = conflictKey(c.lhs_values)
                const pick = chosen(c)
                return (
                  <tr key={key}>
                    {c.lhs_values.map((v, i) => (
                      <td
                        key={i}
                        className="whitespace-nowrap border-b border-border py-2.5 pr-6 align-top font-mono text-[12.5px] text-text"
                      >
                        <Value v={v} />
                      </td>
                    ))}
                    <td className="border-b border-border py-2 align-top">
                      <fieldset disabled={disabled} className="flex flex-wrap gap-1.5">
                        <legend className="sr-only">Value to keep</legend>
                        {c.variants.map((v) => {
                          const on = v.value === pick
                          const suggested = v.value === c.suggested
                          // The fix endpoint takes text overrides only, so NULL can be kept but not chosen.
                          const unpickable = v.value === null && !suggested
                          return (
                            <label
                              key={v.value ?? "(null)"}
                              title={unpickable ? "An empty value can't be chosen as the fix" : undefined}
                              className={
                                "flex cursor-pointer items-center gap-1.5 rounded-[6px] border px-2 py-1 font-mono text-[12.5px] transition-colors " +
                                (on
                                  ? "border-[color-mix(in_oklab,var(--lane-4)_50%,transparent)] bg-[color-mix(in_oklab,var(--lane-4)_11%,transparent)] text-text"
                                  : "border-border-strong text-muted line-through decoration-faint hover:text-text hover:no-underline") +
                                (unpickable ? " cursor-not-allowed opacity-60" : "") +
                                " has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent"
                              }
                            >
                              <input
                                type="radio"
                                className="sr-only"
                                name={`fix-${fdId}-${key}`}
                                checked={on}
                                disabled={unpickable}
                                onChange={() =>
                                  setOverrides((o) => {
                                    const next = { ...o }
                                    if (v.value === c.suggested || v.value === null) delete next[key]
                                    else next[key] = v.value
                                    return next
                                  })
                                }
                              />
                              {on && <Check size={12} strokeWidth={2.5} className="text-lane-4" />}
                              <Value v={v.value} />
                              <span className="text-[11px] text-faint">{fmtInt(v.rows)}</span>
                              {suggested && <span className="font-sans text-[11px] text-lane-4">suggested</span>}
                            </label>
                          )
                        })}
                      </fieldset>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="px-5 pt-2 text-[13.5px] text-muted">
          The disagreeing rows aren't listed for this rule. Fixing sets each one to the value most rows with the same{" "}
          {fd ? fd.lhs.map((n) => cols.get(n)?.label ?? n).join(" and ") : "key"} have.
        </p>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
        <p className="text-[13px] text-muted">
          {truncated
            ? `Showing the first ${LIST_LIMIT} groups. The fix also covers the rest, using each one's suggestion.`
            : "Rows that disagree are rewritten to the ticked value."}
        </p>
        <Button
          size="sm"
          variant="primary"
          loading={fix.isPending}
          disabled={disabled || changes === 0}
          onClick={() => fix.mutate(overrides)}
        >
          Fix {fmtInt(changes)} {changes === 1 ? "row" : "rows"}
        </Button>
      </footer>
      {fix.error && (
        <div className="px-5 pb-3">
          <ActionError error={fix.error} />
        </div>
      )}
    </article>
  )
}
