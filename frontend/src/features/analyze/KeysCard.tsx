import { SectionHeading } from "./bits"
import type { ColumnIndex } from "./util"

export function KeysCard({ keys, cols }: { keys: string[][]; cols: ColumnIndex }) {
  return (
    <section aria-labelledby="keys-h">
      <SectionHeading id="keys-h" title="Candidate keys" count={keys.length}>
        Column sets that pick out exactly one row, where no smaller set would do.
      </SectionHeading>
      {keys.length === 0 ? (
        <p className="rounded-card border border-border bg-surface px-5 py-4 text-[14px] text-muted">
          No set of up to three columns is unique on every row.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2.5">
          {keys.map((k) => (
            <li
              key={k.join(",")}
              className="flex items-center gap-1.5 rounded-card border border-border bg-surface px-2 py-2"
              title={k.map((n) => cols.get(n)?.label ?? n).join(" + ")}
            >
              {k.map((n, i) => (
                <span key={n} className="flex items-center gap-1.5">
                  {i > 0 && <span className="font-mono text-[12px] text-faint">+</span>}
                  <span className="rounded-[6px] bg-raised px-2 py-1 font-mono text-[12.5px] text-text ring-1 ring-border-strong">
                    {n}
                  </span>
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
