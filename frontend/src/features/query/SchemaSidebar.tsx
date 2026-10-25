import { ChevronRight, KeyRound } from "lucide-react"
import { useState } from "react"
import { fmtInt } from "../../lib/format"
import { laneVar } from "../../lib/lanes"
import type { QueryableTable } from "./api"

/**
 * The tables a query can read, each in its lane colour. Clicking a table or column name types it into
 * the editor. The sheet's own tables (_raw, _staging) sit behind a switch: they are readable, but
 * the designed tables are what this screen is about.
 */
export function SchemaSidebar({
  tables,
  sourceTables,
  showSource,
  onShowSource,
  onInsert,
  laneOf,
}: {
  tables: QueryableTable[]
  sourceTables: QueryableTable[]
  showSource: boolean
  onShowSource: (v: boolean) => void
  onInsert: (text: string) => void
  laneOf: (table: string) => number | null
}) {
  return (
    <nav aria-label="Tables you can query" className="flex min-h-0 flex-col">
      <div className="flex items-baseline justify-between px-1 pb-2">
        <h3 className="text-[13px] font-medium text-text">Tables</h3>
        <span className="num text-[12px] text-faint">{tables.length}</span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {tables.map((tb) => (
          <TableItem key={tb.name} table={tb} onInsert={onInsert} laneOf={laneOf} defaultOpen />
        ))}
      </ul>

      <div className="mt-4 border-t border-border pt-3">
        <label className="flex cursor-pointer items-start gap-2.5 px-1 text-[12.5px] leading-snug text-muted">
          <input
            type="checkbox"
            checked={showSource}
            onChange={(e) => onShowSource(e.target.checked)}
            className="mt-0.5 size-3.5 accent-[var(--accent)]"
          />
          <span>
            Show the sheet tables
            <span className="block text-faint">
              <code className="font-mono text-[11.5px]">_raw</code> as uploaded,{" "}
              <code className="font-mono text-[11.5px]">_staging</code> after cleanup
            </span>
          </span>
        </label>
        {showSource && sourceTables.length > 0 && (
          <ul className="anim-enter mt-2 flex flex-col gap-0.5">
            {sourceTables.map((tb) => (
              <TableItem key={tb.name} table={tb} onInsert={onInsert} laneOf={laneOf} />
            ))}
          </ul>
        )}
      </div>
    </nav>
  )
}

function TableItem({
  table,
  onInsert,
  laneOf,
  defaultOpen = false,
}: {
  table: QueryableTable
  onInsert: (text: string) => void
  laneOf: (table: string) => number | null
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const lane = table.color_index
  return (
    <li>
      <div className="group flex h-8 items-center rounded-control hover:bg-hover">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} columns of ${table.name}`}
          className="grid size-7 shrink-0 place-items-center rounded-control text-faint hover:text-text"
        >
          <ChevronRight size={13} className={`transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
        </button>
        <button
          type="button"
          onClick={() => onInsert(table.name)}
          title={`Insert ${table.name}`}
          className="flex min-w-0 flex-1 items-center gap-2 pr-2 text-left"
        >
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full"
            style={lane === null ? { boxShadow: "inset 0 0 0 1.25px var(--muted)" } : { background: laneVar(lane) }}
          />
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-text">{table.name}</span>
          {table.row_count !== null && (
            <span className="num shrink-0 text-[11.5px] text-faint" title={`${fmtInt(table.row_count)} rows`}>
              {fmtInt(table.row_count)}
            </span>
          )}
        </button>
      </div>
      {open && (
        <ul
          className="relative mb-1 ml-[13px] flex flex-col border-l pl-2"
          style={{
            borderColor:
              lane === null ? "var(--border-strong)" : `color-mix(in oklab, ${laneVar(lane)} 45%, transparent)`,
          }}
        >
          {table.columns.map((c) => {
            const fkLane = c.fk ? laneOf(c.fk.table) : null
            return (
              <li key={c.name}>
                <button
                  type="button"
                  onClick={() => onInsert(c.name)}
                  title={c.fk ? `Insert ${c.name} (references ${c.fk.table}.${c.fk.column})` : `Insert ${c.name}`}
                  className="flex h-[26px] w-full items-center gap-1.5 rounded-[6px] px-2 text-left hover:bg-hover"
                >
                  <span className="min-w-0 truncate font-mono text-[12.5px] text-muted group-hover:text-text">
                    {c.name}
                  </span>
                  {c.is_pk && <KeyRound aria-label="primary key" size={11} className="shrink-0 text-lane-6" />}
                  {c.fk && (
                    <span
                      className="ml-auto flex shrink-0 items-center gap-1 pl-2 font-mono text-[11px]"
                      style={{ color: fkLane === null ? "var(--faint)" : laneVar(fkLane) }}
                    >
                      <span aria-hidden>→</span>
                      {c.fk.table}
                    </span>
                  )}
                  {/* a foreign key's type is its target's id type; the target says more in the space */}
                  {!c.fk && (
                    <span className="ml-auto shrink-0 pl-2 font-mono text-[11px] text-faint">
                      {shortType(c.data_type)}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </li>
  )
}

/** "character varying(80)" is noise in a narrow sidebar */
function shortType(t: string): string {
  return t
    .replace("character varying", "varchar")
    .replace("timestamp without time zone", "timestamp")
    .replace("timestamp with time zone", "timestamptz")
    .replace(/\(.*\)$/, "")
}
