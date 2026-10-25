import { Info, Lock, MessageSquareText } from "lucide-react"
import { lazy, Suspense, useEffect, useMemo, useState } from "react"
import { Link, useLocation, useNavigate, useSearchParams } from "react-router"
import { buttonClass } from "../../components/buttonClass"
import { EmptyState } from "../../components/EmptyState"
import { Spinner } from "../../components/Spinner"
import { Tabs, type TabItem } from "../../components/Tabs"
import { useQueryClient } from "@tanstack/react-query"
import { configKey, useAppConfig } from "../../lib/config"
import { fmtInt } from "../../lib/format"
import { useAppliedSchema } from "../../lib/schema"
import { starterQuestions } from "../../lib/snippets"
import { useWorkspaceContext } from "../workspaces/context"
import { StepHeader } from "../workspaces/StepHeader"
import { BrowseTab } from "./BrowseTab"
import "./data.css"
import { useDataChanges } from "./queries"
import type { OpenInEditor } from "./SqlTab"

// The SQL tab carries CodeMirror; it loads the first time the tab opens.
const SqlTab = lazy(() => import("./SqlTab").then((m) => ({ default: m.SqlTab })))
// The assistant loads only when /api/config turns it on.
const SqlAssistant = lazy(() => import("../assistant/SqlAssistant"))

export type DataTab = "browse" | "sql" | "ask"
const TABS: TabItem<DataTab>[] = [
  { key: "browse", label: "Browse" },
  { key: "sql", label: "SQL" },
  { key: "ask", label: "Ask AI" },
]
const isTab = (v: string | null): v is DataTab => v === "sql" || v === "ask" || v === "browse"

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

/**
 * The Data step is where the new database gets used: Browse (rows, edits, the audit log), SQL (any SELECT, plus a
 * confirmed INSERT/UPDATE/DELETE, with plans and a step-through), and Ask AI (plain-English questions, read-only).
 * The tab lives in the URL (?tab=sql), so History, the assistant and the old /query and /perf links can open it.
 */
function DataHub({ wsId }: { wsId: number }) {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const asked = params.get("tab")
  const tab: DataTab = isTab(asked) ? asked : "browse"
  // a tab stays mounted once opened, so switching back keeps the editor, its results and the grid as they were
  const [visited, setVisited] = useState<Set<DataTab>>(() => new Set([tab]))
  if (!visited.has(tab)) setVisited(new Set([...visited, tab]))

  // SQL handed over by another screen (History, Design's assistant) or by Ask AI
  const handed = (location.state as { open?: OpenInEditor } | null)?.open ?? null
  const [incoming, setIncoming] = useState<OpenInEditor | null>(handed)
  const [seen, setSeen] = useState(handed)
  if (handed && handed !== seen) {
    setSeen(handed)
    setIncoming(handed)
  }
  useEffect(() => {
    if (!handed) return
    // taken; drop it from the history entry so a reload keeps later edits
    navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null })
  }, [handed, navigate, location.pathname, location.search])

  const changes = useDataChanges(wsId)
  const edited = changes.data?.edited_rows ?? 0
  const changeCount = changes.data?.change_count ?? 0

  const go = (k: DataTab) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p)
        if (k === "browse") n.delete("tab")
        else n.set("tab", k)
        return n
      },
      { replace: false },
    )

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
        Use the database Design created: browse and edit rows, run SQL against it, or ask a question in plain English.
        The database's own constraints decide what is allowed, and a trigger records every change.
      </StepHeader>

      <Tabs items={TABS} value={tab} onChange={go} className="mb-6" />
      {TABS.map(({ key, label }) =>
        visited.has(key) ? (
          <div key={key} role="tabpanel" aria-label={label as string} hidden={key !== tab} className="dw-tab-in">
            {key === "browse" && <BrowseTab wsId={wsId} />}
            {key === "sql" && (
              <Suspense
                fallback={
                  <div className="grid min-h-[40dvh] place-items-center">
                    <Spinner size={20} />
                  </div>
                }
              >
                <SqlTab wsId={wsId} incoming={incoming} />
              </Suspense>
            )}
            {key === "ask" && (
              <AskTab
                wsId={wsId}
                onOpenSql={(sql) => {
                  setIncoming({ sql })
                  go("sql")
                }}
              />
            )}
          </div>
        ) : null,
      )}
    </div>
  )
}

/**
 * Ask AI: plain-English questions about the rows, answered inline and full width. The assistant writes a SELECT,
 * runs it read-only and answers with the rows and the SQL, which "Open in SQL tab" hands to the editor.
 */
function AskTab({ wsId, onOpenSql }: { wsId: number; onOpenSql: (sql: string) => void }) {
  const config = useAppConfig()
  // useAppConfig reads "off" until the answer arrives; wait for it rather than flash "Ask AI is off"
  const configReady = useQueryClient().getQueryState(configKey)?.status !== "pending"
  const schema = useAppliedSchema(wsId)
  const tables = useMemo(() => schema.data?.tables ?? [], [schema.data])
  const starters = useMemo(() => starterQuestions(tables), [tables])

  if (!configReady || schema.isPending)
    return (
      <div className="grid min-h-[30dvh] place-items-center">
        <Spinner size={20} />
      </div>
    )
  if (!config.assistant_enabled)
    return (
      <EmptyState icon={<MessageSquareText size={18} strokeWidth={1.5} />} title="Ask AI is off" lanes={[3, 1]}>
        The server has no Gemini API key, so plain-English questions are turned off. Browse and SQL work without it.
      </EmptyState>
    )
  return (
    <Suspense fallback={<div className="h-[160px]" />}>
      <SqlAssistant
        wsId={wsId}
        context="data"
        variant="page"
        tables={tables}
        starters={starters}
        onInsertSql={onOpenSql}
        insertLabel="Open in SQL tab"
      />
    </Suspense>
  )
}
