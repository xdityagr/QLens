import { Info, Lock } from "lucide-react"
import { useState } from "react"
import { Link } from "react-router"
import { buttonClass } from "../../components/buttonClass"
import { EmptyState } from "../../components/EmptyState"
import { Tabs, type TabItem } from "../../components/Tabs"
import { fmtInt } from "../../lib/format"
import { useWorkspaceContext } from "../workspaces/context"
import { StepHeader } from "../workspaces/StepHeader"
import { BrowseTab } from "./BrowseTab"
import "./data.css"
import { useDataChanges } from "./queries"

// The Data step is the hub for using the database; more tabs (SQL, Ask AI) join Browse later.
type DataTab = "browse"
const TABS: TabItem<DataTab>[] = [{ key: "browse", label: "Browse" }]

export function DataPage() {
  const { workspace } = useWorkspaceContext()
  if (workspace.stage !== "applied") {
    return (
      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-8 sm:py-12">
        <StepHeader step="data" />
        <EmptyState
          icon={<Lock size={18} strokeWidth={1.5} />}
          title="Apply a design first"
          lanes={[4, 0]}
          action={
            <Link to={`/w/${workspace.id}/design`} className={buttonClass("primary")}>
              Go to Design
            </Link>
          }
        >
          This screen works on the tables Design creates, so there is nothing here until a design is applied.
        </EmptyState>
      </div>
    )
  }
  return <DataHub wsId={workspace.id} />
}

function DataHub({ wsId }: { wsId: number }) {
  const [tab, setTab] = useState<DataTab>("browse")
  const changes = useDataChanges(wsId)
  const edited = changes.data?.edited_rows ?? 0
  const changeCount = changes.data?.change_count ?? 0

  return (
    <div className="mx-auto max-w-[1480px] px-4 py-8 sm:px-8 sm:py-10">
      <StepHeader
        step="data"
        actions={
          edited > 0 && (
            <p className="flex max-w-[320px] items-start gap-2.5 rounded-control border border-border bg-surface px-3 py-2 text-[12.5px] leading-snug">
              <Info size={14} className="mt-0.5 shrink-0 text-lane-3" aria-hidden />
              <span>
                <span className="text-text">
                  {fmtInt(changeCount)} {changeCount === 1 ? "change" : "changes"} to {fmtInt(edited)}{" "}
                  {edited === 1 ? "row" : "rows"} since the design was applied.
                </span>{" "}
                <span className="text-muted">
                  Applying a design again rebuilds the tables from the sheet and discards them.
                </span>
              </span>
            </p>
          )
        }
      >
        Browse the tables Design created and add, edit or delete rows. The database's own constraints decide what is
        allowed, and a trigger records every change.
      </StepHeader>

      <Tabs items={TABS} value={tab} onChange={setTab} className="mb-6" />
      <div role="tabpanel" aria-label={TABS.find((t) => t.key === tab)?.label as string}>
        {tab === "browse" && <BrowseTab wsId={wsId} />}
      </div>
    </div>
  )
}
