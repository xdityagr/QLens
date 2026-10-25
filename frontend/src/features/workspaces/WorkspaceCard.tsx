import { Trash2 } from "lucide-react"
import { Link } from "react-router"
import { Badge } from "../../components/Badge"
import { IconButton } from "../../components/Button"
import { fmtInt, fmtRelative } from "../../lib/format"
import { STAGE_META, nextStep, stepStates } from "../../lib/steps"
import type { WorkspaceOut } from "../../lib/types"

/** Six-node progress lane: the StepRail at card scale. */
function MiniRail({ ws }: { ws: WorkspaceOut }) {
  const steps = stepStates(ws.stage)
  const current = steps.find((s) => s.state === "current")!
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center" aria-hidden>
        {steps.map((s, i) => {
          const lit = s.state !== "locked" && steps[i + 1] && steps[i + 1].state !== "locked"
          return (
            <span key={s.key} className="flex items-center">
              {s.state === "done" ? (
                <span className="size-[7px] rounded-full bg-accent" />
              ) : s.state === "current" ? (
                <span className="grid size-[11px] place-items-center rounded-full border-[1.5px] border-accent">
                  <span className="size-[3px] rounded-full bg-accent" />
                </span>
              ) : s.state === "open" ? (
                <span className="size-[8px] rounded-full border-[1.5px] border-accent" />
              ) : (
                <span className="size-[8px] rounded-full border-[1.25px] border-faint" />
              )}
              {i < steps.length - 1 && (
                <span
                  className="mx-[3px] h-0 w-4"
                  style={lit ? { borderTop: "1.5px solid var(--accent)" } : { borderTop: "1.5px dashed var(--border-strong)" }}
                />
              )}
            </span>
          )
        })}
      </div>
      <span className="text-[12.5px] text-muted">
        {ws.stage === "applied" ? "Ready to query" : `Next: ${current.label}`}
      </span>
    </div>
  )
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="num text-[13.5px] text-text">{fmtInt(value)}</span>
      <span className="text-[13px] text-muted">{label}</span>
    </span>
  )
}

export function WorkspaceCard({ ws, onDelete }: { ws: WorkspaceOut; onDelete: (ws: WorkspaceOut) => void }) {
  const meta = STAGE_META[ws.stage]
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)
  return (
    <div className="group relative rounded-card border border-border bg-surface transition-colors duration-150 hover:border-border-strong focus-within:border-border-strong">
      <Link
        to={`/w/${ws.id}/${nextStep(ws.stage)}`}
        className="flex h-full flex-col gap-5 rounded-card p-5 outline-offset-[-1px]"
      >
        <div className="min-w-0 pr-28">
          <h3 className="truncate text-[17px] font-medium tracking-[-0.02em] text-text">{ws.name}</h3>
          <p className="mt-0.5 text-[12.5px] text-faint">
            Active <time dateTime={ws.last_activity_at ?? undefined}>{fmtRelative(ws.last_activity_at)}</time>
          </p>
        </div>

        <MiniRail ws={ws} />

        <div className="mt-auto flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-border pt-4">
          {ws.row_count === null ? (
            <span className="text-[13px] text-muted">No sheet imported</span>
          ) : (
            <>
              <Stat value={ws.row_count} label={plural(ws.row_count, "row", "rows")} />
              {ws.table_count !== null ? (
                <Stat value={ws.table_count} label={plural(ws.table_count, "table", "tables")} />
              ) : (
                <Stat value={ws.column_count ?? 0} label={plural(ws.column_count ?? 0, "column", "columns")} />
              )}
              {ws.stage === "applied" && <Stat value={ws.query_count} label={plural(ws.query_count, "query", "queries")} />}
            </>
          )}
        </div>
      </Link>

      <div className="absolute right-4 top-4 flex items-center gap-1">
        <Badge lane={meta.lane} className="transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
          {meta.label}
        </Badge>
        <IconButton
          label={`Delete ${ws.name}`}
          onClick={() => onDelete(ws)}
          className="absolute right-0 opacity-0 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Trash2 size={15} strokeWidth={1.75} />
        </IconButton>
      </div>
    </div>
  )
}
