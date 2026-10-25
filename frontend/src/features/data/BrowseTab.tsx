import { useMemo } from "react"
import { useSearchParams } from "react-router"
import { EmptyState } from "../../components/EmptyState"
import { Spinner } from "../../components/Spinner"
import { fmtInt } from "../../lib/format"
import { laneVar } from "../../lib/lanes"
import { useAppliedSchema } from "../../lib/schema"
import { ChangeTimeline } from "./ChangeTimeline"
import { useDataChanges } from "./queries"
import { TableView } from "./TableView"

/**
 * Browse: the applied tables (lane dots, live row counts), one table's grid with its filters and side panel,
 * and the trigger's audit log beside it. The chosen table and filters live in the URL (?table=&f=).
 */
export function BrowseTab({ wsId }: { wsId: number }) {
  const schema = useAppliedSchema(wsId)
  const changes = useDataChanges(wsId)
  const [params, setParams] = useSearchParams()
  const tables = useMemo(() => schema.data?.tables ?? [], [schema.data])
  const lanes = useMemo(() => new Map(tables.map((t) => [t.name, t.color_index])), [tables])
  const laneOf = (name: string) => lanes.get(name) ?? 0
  const asked = params.get("table")
  const current = tables.find((t) => t.name === asked) ?? tables[0] ?? null

  if (schema.isPending)
    return (
      <div className="grid min-h-[30dvh] place-items-center text-muted">
        <Spinner size={20} />
      </div>
    )
  if (schema.error || !current)
    return (
      <EmptyState title="Couldn't load the tables" lanes={[7, 3]}>
        {schema.error?.message ?? "The applied design has no tables."}
      </EmptyState>
    )

  return (
    <>
      <nav aria-label="Tables" className="scrollbar-thin -mx-1 mb-5 overflow-x-auto px-1 pb-1">
        <ul className="flex min-w-max gap-2">
          {tables.map((t) => {
            const on = t.name === current.name
            return (
              <li key={t.name}>
                <button
                  type="button"
                  aria-current={on ? "true" : undefined}
                  // a different table starts unfiltered
                  onClick={() => setParams({ table: t.name })}
                  className={
                    "relative flex h-10 items-center gap-2.5 rounded-control border px-3.5 text-[13.5px] transition-[background-color,border-color,color] duration-150 active:scale-[0.98] " +
                    (on
                      ? "border-border-strong bg-raised text-text"
                      : "border-transparent text-muted hover:bg-hover hover:text-text")
                  }
                >
                  <span aria-hidden className="size-2 rounded-full" style={{ background: laneVar(t.color_index) }} />
                  <span className="font-mono text-[13px]">{t.name}</span>
                  <span className="num text-[12px] text-faint">{fmtInt(t.row_count)}</span>
                  {on && (
                    <span
                      aria-hidden
                      className="absolute inset-x-3 -bottom-px h-[2px] rounded-full"
                      style={{ background: laneVar(t.color_index) }}
                    />
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      {/* The log sits beside the grid only when the grid keeps ~760px for itself; narrower, it goes underneath.
          The grid scrolls sideways inside its own frame, never the page. */}
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-6 min-[1440px]:grid-cols-[minmax(0,1fr)_340px]">
        <TableView key={current.name} wsId={wsId} table={current.name} laneOf={laneOf} />
        <ChangeTimeline
          data={changes.data}
          pending={changes.isPending}
          laneOf={laneOf}
          columnsOf={(name) => tables.find((t) => t.name === name)?.columns.map((c) => c.name) ?? []}
        />
      </div>
    </>
  )
}
