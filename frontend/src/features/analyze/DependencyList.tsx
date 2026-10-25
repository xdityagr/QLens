import { Check } from "lucide-react"
import { useState, type ReactNode } from "react"
import { Badge } from "../../components/Badge"
import { groupFdsByLhs } from "../../lib/analysis"
import { laneVar } from "../../lib/lanes"
import type { FDOut } from "../../lib/types"
import { ActionError, ColLabel, SectionHeading } from "./bits"
import type { ColumnIndex } from "./util"
import { useSetAccepted } from "./queries"

/**
 * Dependencies drawn like a commit graph: each determinant is a lane, each rule a node on it.
 * Lanes are assigned over all dependencies, so a group keeps its colour when derived ones are shown.
 */
export function DependencyList({ wsId, fds, cols }: { wsId: number; fds: FDOut[]; cols: ColumnIndex }) {
  const [showDerived, setShowDerived] = useState(false)
  const setAccepted = useSetAccepted(wsId)
  const derived = fds.filter((f) => f.is_derived).length
  const groups = groupFdsByLhs(fds)
    .map((g, lane) => ({ ...g, lane, fds: g.fds.filter((f) => showDerived || !f.is_derived) }))
    .filter((g) => g.fds.length > 0)
  const visible = groups.reduce((n, g) => n + g.fds.length, 0)

  return (
    <section aria-labelledby="deps-h">
      <SectionHeading
        id="deps-h"
        title="Dependencies"
        count={visible}
        aside={
          derived > 0 && (
            <label className="flex cursor-pointer items-center gap-2.5 text-[13px] text-muted select-none hover:text-text">
              <input
                type="checkbox"
                className="peer sr-only"
                checked={showDerived}
                onChange={(e) => setShowDerived(e.target.checked)}
              />
              <span
                aria-hidden
                className="relative h-[18px] w-[30px] rounded-full bg-border-strong transition-colors peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent after:absolute after:left-[3px] after:top-[3px] after:size-3 after:rounded-full after:bg-bg after:transition-transform peer-checked:after:translate-x-3"
              />
              Show derived dependencies ({derived})
            </label>
          )
        }
      >
        Read each line as a rule the sheet follows. Ticked exact rules decide the tables in Design; untick a rule that
        only holds by coincidence.
      </SectionHeading>

      {groups.length === 0 ? (
        <p className="rounded-card border border-border bg-surface px-5 py-4 text-[14px] text-muted">
          No column determines another. Every column varies independently in this sheet.
        </p>
      ) : (
        <div className="rounded-card border border-border bg-surface px-3 py-2 sm:px-4">
          {groups.map((g, gi) => (
            <div key={JSON.stringify(g.lhs)} className={gi > 0 ? "border-t border-border" : ""}>
              <LaneGroup lhs={g.lhs} lane={g.lane} cols={cols}>
                {g.fds.map((f, i) => (
                  <FdRow
                    key={f.id}
                    fd={f}
                    lane={g.lane}
                    last={i === g.fds.length - 1}
                    pending={setAccepted.isPending && setAccepted.variables?.fdId === f.id}
                    onToggle={(accepted) => setAccepted.mutate({ fdId: f.id, accepted })}
                  />
                ))}
              </LaneGroup>
            </div>
          ))}
        </div>
      )}
      {setAccepted.error && (
        <div className="mt-2">
          <ActionError error={setAccepted.error} />
        </div>
      )}
    </section>
  )
}

function LaneGroup({
  lhs,
  lane,
  cols,
  children,
}: {
  lhs: string[]
  lane: number
  cols: ColumnIndex
  children: ReactNode
}) {
  return (
    <div className="py-3">
      <div className="flex min-h-8 items-center gap-3">
        <span className="relative w-5 shrink-0 self-stretch" aria-hidden>
          <span
            className="absolute left-1/2 top-1/2 h-1/2 w-0 -translate-x-1/2"
            style={{ borderLeft: `1.5px solid ${laneVar(lane)}` }}
          />
          <span
            className="absolute left-1/2 top-1/2 size-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ background: laneVar(lane) }}
          />
        </span>
        <h4 className="flex flex-wrap items-baseline gap-x-2 text-[14px] font-medium text-text">
          {lhs.map((n, i) => (
            <span key={n} className="flex items-baseline gap-2">
              {i > 0 && <span className="font-normal text-faint">and</span>}
              <ColLabel name={n} cols={cols} inline />
            </span>
          ))}
          <span className="font-normal text-muted">{lhs.length > 1 ? "together determine" : "determines"}</span>
        </h4>
      </div>
      <ul>{children}</ul>
    </div>
  )
}

function FdRow({
  fd,
  lane,
  last,
  pending,
  onToggle,
}: {
  fd: FDOut
  lane: number
  last: boolean
  pending: boolean
  onToggle: (accepted: boolean) => void
}) {
  const color = laneVar(lane)
  const id = `fd-${fd.id}`
  return (
    <li className="relative flex min-h-11 items-center gap-3">
      {/* lane: a vertical line from the group's node, ending at the last rule */}
      <span aria-hidden className="relative w-5 shrink-0 self-stretch">
        <span
          className="absolute left-1/2 top-0 w-0 -translate-x-1/2"
          style={{
            height: last ? "50%" : "100%",
            borderLeft: `1.5px ${fd.is_derived ? "dashed" : "solid"} ${color}`,
            opacity: fd.accepted ? 1 : 0.45,
          }}
        />
        <span
          className="absolute left-1/2 top-1/2 size-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={
            !fd.accepted
              ? { background: "var(--surface)", boxShadow: "inset 0 0 0 1.5px var(--faint)" }
              : fd.is_exact && !fd.is_derived
                ? { background: color }
                : { background: "var(--surface)", boxShadow: `inset 0 0 0 1.5px ${color}` }
          }
        />
      </span>

      <input
        id={id}
        type="checkbox"
        className="peer sr-only"
        checked={fd.accepted}
        disabled={pending}
        onChange={(e) => onToggle(e.target.checked)}
      />
      <label
        htmlFor={id}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-control py-2 pr-2 peer-focus-visible:outline-2 peer-focus-visible:outline-accent"
        title={`${fd.lhs.join(", ")} → ${fd.rhs}`}
      >
        <span
          aria-hidden
          className={
            "grid size-4 shrink-0 place-items-center rounded-[4px] transition-colors " +
            (fd.accepted ? "bg-accent text-on-accent" : "ring-1 ring-inset ring-border-strong")
          }
        >
          {fd.accepted && <Check size={11} strokeWidth={3} />}
        </span>
        <span
          className={`min-w-0 flex-1 text-[14px] leading-snug ${fd.accepted ? "text-text" : "text-muted line-through decoration-faint"}`}
        >
          {fd.sentence}
        </span>
        <span className="hidden shrink-0 items-center gap-2 sm:flex">
          {fd.is_derived && <span className="text-[12px] text-faint">derived</span>}
          {fd.is_exact ? <Badge lane={4}>Exact</Badge> : <Badge lane={3}>Approximate</Badge>}
        </span>
      </label>
    </li>
  )
}
