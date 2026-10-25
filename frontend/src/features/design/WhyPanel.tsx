import { laneVar } from "../../lib/lanes"
import type { ProposalOut } from "../../lib/types"

/** Why each table exists, in the words the backend wrote for it, with the tables it points to. */
export function WhyPanel({
  proposal,
  hovered,
  onHover,
}: {
  proposal: ProposalOut
  hovered: number | null
  onHover: (id: number | null) => void
}) {
  const byId = new Map(proposal.tables.map((t) => [t.id, t]))
  const n = proposal.tables.length
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] leading-relaxed text-muted">
        The sheet's <span className="num text-text">{proposal.source_columns.length}</span> columns became{" "}
        <span className="num text-text">{n}</span> {n === 1 ? "table" : "tables"}, one for each group of columns that a
        key decides, built from the dependencies you accepted in Analyze.
      </p>
      <ul className="flex flex-col gap-1">
        {proposal.tables.map((t) => {
          const refs = [
            ...new Set(
              t.columns
                .filter((c) => c.role === "fk" && c.references_table_id !== null)
                .map((c) => c.references_table_id!),
            ),
          ]
            .map((id) => byId.get(id))
            .filter((x) => x !== undefined)
          const hot = hovered === t.id
          return (
            <li
              key={t.id}
              onMouseEnter={() => onHover(t.id)}
              onMouseLeave={() => onHover(null)}
              className="-mx-2.5 rounded-control px-2.5 py-2.5 transition-colors duration-150"
              style={{ background: hot ? "var(--hover)" : undefined }}
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: laneVar(t.color_index) }}
                />
                <span className="font-mono text-[13px] font-medium text-text">{t.name}</span>
              </div>
              <p className="mt-1 pl-4 text-[13px] leading-relaxed text-muted">{t.explanation}</p>
              {refs.length > 0 && (
                <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-4 text-[12px] text-faint">
                  Points to
                  {refs.map((r) => (
                    <span
                      key={r.id}
                      className="inline-flex items-center gap-1 font-mono text-[11.5px]"
                      style={{ color: laneVar(r.color_index) }}
                    >
                      {r.name}
                    </span>
                  ))}
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
