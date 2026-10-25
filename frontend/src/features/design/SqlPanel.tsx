import { CodeBlock } from "../../components/CodeBlock"
import { Spinner } from "../../components/Spinner"
import { useProposalSql } from "./queries"

/** The exact script Apply runs, regenerated after every rename. */
export function SqlPanel({ wsId }: { wsId: number }) {
  const sql = useProposalSql(wsId, true)
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-[13px] leading-relaxed text-muted">
        This is the script Apply runs: create the tables, copy the sheet's rows into them, rebuild the sheet as a view,
        then compare it with the original using <code className="font-mono text-[12px] text-text">EXCEPT ALL</code> in
        both directions.
      </p>
      {sql.isPending ? (
        <div className="grid h-40 place-items-center text-muted">
          <Spinner size={18} />
        </div>
      ) : sql.error ? (
        <p role="alert" className="text-[13px] text-danger">
          {sql.error.message}
        </p>
      ) : (
        <CodeBlock code={sql.data.sql} label="design.sql" className="min-w-0" />
      )}
    </div>
  )
}
