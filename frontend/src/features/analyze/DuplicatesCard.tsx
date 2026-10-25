import { Check, ChevronRight } from "lucide-react"
import { useState } from "react"
import { Badge } from "../../components/Badge"
import { Button } from "../../components/Button"
import { analysisApi } from "../../lib/api"
import { fmtInt } from "../../lib/format"
import type { DuplicateGroupOut } from "../../lib/types"
import { ActionError, ColLabel, SectionHeading, Value } from "./bits"
import type { ColumnIndex } from "./util"
import { useCleanup } from "./queries"

export function DuplicatesSection({
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
  const pending = groups.filter((g) => g.status === "pending")
  const resolved = groups.filter((g) => g.status !== "pending")
  const [showResolved, setShowResolved] = useState(false)

  return (
    <section aria-labelledby="dups-h">
      <SectionHeading id="dups-h" title="Near-duplicates" count={pending.length}>
        The same value typed more than one way. Merging rewrites the other spellings to the one you pick.
      </SectionHeading>

      {pending.length === 0 ? (
        <p className="rounded-card border border-border bg-surface px-5 py-4 text-[14px] text-muted">
          {groups.length === 0
            ? "No text column has values that differ only by case, spacing or a near-miss spelling."
            : "Nothing left to review here."}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {pending.map((g) => (
            <DuplicateGroup key={g.id} wsId={wsId} group={g} cols={cols} busy={busy} />
          ))}
        </div>
      )}

      {resolved.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowResolved((v) => !v)}
            aria-expanded={showResolved}
            className="flex h-8 items-center gap-1.5 rounded-control px-1 text-[13px] text-muted transition-colors hover:text-text"
          >
            <ChevronRight size={14} className={`transition-transform ${showResolved ? "rotate-90" : ""}`} />
            Resolved <span className="num text-faint">{resolved.length}</span>
          </button>
          {showResolved && (
            <ul className="mt-1 flex flex-col divide-y divide-border rounded-card border border-border">
              {resolved.map((g) => (
                <li key={g.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13.5px]">
                  <span className="w-20 shrink-0 text-muted">{g.status === "merged" ? "Merged" : "Dismissed"}</span>
                  <span className="text-muted">
                    <ColLabel name={g.column} cols={cols} inline />
                  </span>
                  <span className="min-w-0 font-mono text-[12.5px] text-text">
                    {g.status === "merged" ? (
                      <>
                        into <Value v={g.canonical_value} />
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
    </section>
  )
}

function DuplicateGroup({
  wsId,
  group,
  cols,
  busy,
}: {
  wsId: number
  group: DuplicateGroupOut
  cols: ColumnIndex
  busy: boolean
}) {
  const [canonical, setCanonical] = useState(group.canonical_value)
  const merge = useCleanup(wsId, (c: string | undefined) => analysisApi.merge(wsId, group.id, c))
  const dismiss = useCleanup(wsId, () => analysisApi.dismiss(wsId, group.id))
  const same = group.confidence === "same_normalized"
  const changes = group.values.filter((v) => v.value !== canonical).reduce((n, v) => n + v.rows, 0)
  const disabled = busy || merge.isPending || dismiss.isPending
  const name = `dup-${group.id}`

  return (
    <article
      className={
        "rounded-card border bg-surface " +
        // a solid edge for "same letters", a dashed one for "looks alike": the second needs a human look
        (same ? "border-border" : "border-dashed border-border-strong")
      }
    >
      <header className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
        <div className="text-[14.5px] font-medium text-text">
          <ColLabel name={group.column} cols={cols} inline />
        </div>
        {same ? (
          <Badge lane={4}>Same apart from case or spacing</Badge>
        ) : (
          <Badge lane={3}>
            Similar spelling
            {group.max_similarity !== null && (
              <>
                , <span className="num">{Math.round(group.max_similarity * 100)}%</span> alike
              </>
            )}
          </Badge>
        )}
      </header>

      <fieldset className="px-5 pt-3.5" disabled={disabled}>
        <legend className="sr-only">Keep which spelling?</legend>
        <div className="flex flex-wrap gap-2">
          {group.values.map((v) => {
            const on = v.value === canonical
            return (
              <label
                key={v.value}
                className={
                  "flex cursor-pointer items-center gap-2 rounded-control border px-2.5 py-1.5 font-mono text-[13px] transition-colors " +
                  (on
                    ? "border-[color-mix(in_oklab,var(--accent)_55%,transparent)] bg-[color-mix(in_oklab,var(--accent)_10%,transparent)] text-text"
                    : "border-border-strong text-muted hover:text-text") +
                  " has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent"
                }
              >
                <input
                  type="radio"
                  name={name}
                  className="sr-only"
                  checked={on}
                  onChange={() => setCanonical(v.value)}
                />
                <span
                  aria-hidden
                  className={`grid size-3.5 place-items-center rounded-full ${on ? "bg-accent text-on-accent" : "ring-1 ring-faint"}`}
                >
                  {on && <Check size={9} strokeWidth={3} />}
                </span>
                <Value v={v.value} />
                <span className="text-[11.5px] text-faint">
                  {fmtInt(v.rows)} {v.rows === 1 ? "row" : "rows"}
                </span>
              </label>
            )
          })}
        </div>
      </fieldset>

      <footer className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3">
        <p className="text-[13px] text-muted">
          {changes === 0 ? (
            "Pick the spelling to keep."
          ) : (
            <>
              Rewrites <span className="num text-text">{fmtInt(changes)}</span> {changes === 1 ? "row" : "rows"} to{" "}
              <span className="font-mono text-text">
                <Value v={canonical} />
              </span>
            </>
          )}
        </p>
        <div className="flex items-center gap-2">
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
            onClick={() => merge.mutate(canonical === group.canonical_value ? undefined : canonical)}
          >
            Merge
          </Button>
        </div>
      </footer>
      {(merge.error || dismiss.error) && (
        <div className="px-5 pb-3">
          <ActionError error={merge.error ?? dismiss.error} />
        </div>
      )}
    </article>
  )
}
