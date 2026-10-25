import { ShieldAlert, X } from "lucide-react"
import { IconButton } from "../../components/Button"
import { constraintRule } from "../../lib/constraintRule"
import { constraintDetail } from "./api"

const OUTCOME: Record<string, [string, string]> = {
  INSERT: ["the new row", "nothing was saved"],
  UPDATE: ["the change", "the row is as it was"],
  DELETE: ["the delete", "the row is still there"],
}

/**
 * A write the database refused: which rule (kind + constraint name), the plain-English reason, and the
 * rule as PostgreSQL defines it. Keyed by the caller per attempt, so a repeated refusal plays again.
 */
export function ConstraintCard({ error, onDismiss }: { error: Error; onDismiss?: () => void }) {
  const d = constraintDetail(error)
  if (!d) {
    return (
      <div role="alert" className="dc-card rounded-card border border-border-strong bg-raised px-4 py-3 text-[14px]">
        <p className="text-danger">{error.message}</p>
      </div>
    )
  }
  const { rule, name } = constraintRule(d)
  const [what, outcome] = OUTCOME[d.operation] ?? ["the write", "nothing changed"]
  return (
    <div
      role="alert"
      className="dc-card relative overflow-hidden rounded-card border bg-raised py-3.5 pl-5 pr-3"
      style={{ borderColor: "color-mix(in oklab, var(--danger) 38%, var(--border-strong))" }}
    >
      <span aria-hidden className="dc-stripe absolute inset-y-0 left-0 w-[3px] bg-danger" />
      <div className="flex items-start gap-3">
        <ShieldAlert size={17} strokeWidth={1.75} className="mt-0.5 shrink-0 text-danger" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-[12.5px]">
            <span className="font-semibold tracking-[0.02em] text-danger">{rule}</span>
            <span className="break-all text-text">{name}</span>
          </p>
          <p className="mt-1.5 text-[15px] leading-snug text-text">{error.message}</p>
          {d.definition && (
            <code className="mt-2 block break-words rounded-[6px] bg-hover px-2 py-1 font-mono text-[11.5px] leading-relaxed text-muted">
              {d.definition}
            </code>
          )}
          <p className="mt-2 text-[12px] text-muted">
            PostgreSQL refused {what} with SQLSTATE <span className="font-mono text-text">{d.sqlstate}</span>; {outcome}
            .
          </p>
        </div>
        {onDismiss && (
          <IconButton label="Dismiss" onClick={onDismiss} className="-mr-1 -mt-1 shrink-0">
            <X size={15} />
          </IconButton>
        )}
      </div>
    </div>
  )
}
