import { Check } from "lucide-react"
import { useState, type ReactNode } from "react"
import { Badge } from "../../components/Badge"
import { groupFdsByLhs } from "../../lib/analysis"
import { laneVar } from "../../lib/lanes"
import type { FDOut } from "../../lib/types"
import { ActionError, ColLabel } from "./bits"
import { ruleId, type ColumnIndex } from "./util"
import { useSetAccepted } from "./queries"

/**
 * Dependencies drawn like a commit graph: each determinant is a lane, each rule a node on it.
 * Lanes are assigned over all dependencies, so a group keeps its colour when derived ones are shown.
 */
export function DependencyList({
  wsId,
  fds,
  cols,
  showDerived,
  selected,
}: {
  wsId: number
  fds: FDOut[]
  cols: ColumnIndex
  showDerived: boolean
  /** column picked in the diagram: its rules stay lit, the rest fade */
  selected: string | null
}) {
  const setAccepted = useSetAccepted(wsId)
  const groups = groupFdsByLhs(fds)
    .map((g, lane) => ({ ...g, lane, fds: g.fds.filter((f) => showDerived || !f.is_derived) }))
    .filter((g) => g.fds.length > 0)
  const visible = groups.reduce((n, g) => n + g.fds.length, 0)
  const touches = (f: FDOut) => !selected || f.rhs === selected || f.lhs.includes(selected)

  return (
    <section aria-labelledby="deps-h" className="@container">
      <h3 id="deps-h" className="mb-3 flex items-baseline gap-2.5 text-[19px] font-medium tracking-[-0.02em] text-text">
        Dependencies
        <span className="num text-[13px] font-normal text-faint">{visible}</span>
      </h3>

      {groups.length === 0 ? (
        <p className="rounded-card border border-border bg-surface px-5 py-4 text-[14px] text-muted">
          No column determines another. Every column varies independently in this sheet.
        </p>
      ) : (
        <div className="rounded-card border border-border bg-surface">
          <p className="border-b border-border px-4 py-3 text-[12.5px] leading-snug text-muted">
            Ticked exact rules decide the tables in Design. Untick a rule that only holds by coincidence.
          </p>
          <div className="px-3 py-1">
            {groups.map((g, gi) => (
              <div
                key={JSON.stringify(g.lhs)}
                className={
                  (gi > 0 ? "border-t border-border " : "") +
                  "transition-opacity duration-200 " +
                  (g.fds.some(touches) ? "" : "opacity-40")
                }
              >
                <LaneGroup lhs={g.lhs} lane={g.lane} cols={cols}>
                  {g.fds.map((f, i) => (
                    <FdRow
                      key={f.id}
                      fd={f}
                      lane={g.lane}
                      last={i === g.fds.length - 1}
                      dim={!touches(f)}
                      pending={setAccepted.isPending && setAccepted.variables?.fdId === f.id}
                      onToggle={(accepted) => setAccepted.mutate({ fdId: f.id, accepted })}
                    />
                  ))}
                </LaneGroup>
              </div>
            ))}
          </div>
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
  dim,
  pending,
  onToggle,
}: {
  fd: FDOut
  lane: number
  last: boolean
  dim: boolean
  pending: boolean
  onToggle: (accepted: boolean) => void
}) {
  const color = laneVar(lane)
  const id = `fd-${fd.id}`
  // tick animation only after the user toggles, not on first paint
  const [touched, setTouched] = useState(false)
  return (
    <li
      id={ruleId(fd.id)}
      tabIndex={-1}
      className={`relative flex min-h-11 items-center gap-3 outline-none transition-opacity duration-200 ${dim ? "opacity-45" : ""}`}
    >
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
        onChange={(e) => {
          setTouched(true)
          onToggle(e.target.checked)
        }}
      />
      <label
        htmlFor={id}
        className="group flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-control py-2 pr-2 peer-focus-visible:outline-2 peer-focus-visible:outline-accent"
        title={`${fd.lhs.join(", ")} → ${fd.rhs}`}
      >
        <span
          aria-hidden
          className={
            "grid size-4 shrink-0 place-items-center rounded-[4px] transition-[background-color,box-shadow,transform] duration-150 group-active:scale-90 " +
            (fd.accepted ? "bg-accent text-on-accent" : "ring-1 ring-inset ring-border-strong")
          }
        >
          {fd.accepted && <Check size={11} strokeWidth={3} className={touched ? "anim-tick" : undefined} />}
        </span>
        <span
          className={`min-w-0 flex-1 text-[14px] leading-snug ${fd.accepted ? "text-text" : "text-muted line-through decoration-faint"}`}
        >
          {fd.sentence}
        </span>
        <span className="hidden shrink-0 items-center gap-2 @md:flex">
          {fd.is_derived && <span className="text-[12px] text-faint">derived</span>}
          {fd.is_exact ? <Badge lane={4}>Exact</Badge> : <Badge lane={3}>Approximate</Badge>}
        </span>
      </label>
    </li>
  )
}
