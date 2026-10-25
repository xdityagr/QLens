import { History, Lock, Pencil, Play, Save, Trash2 } from "lucide-react"
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useLocation, useNavigate } from "react-router"
import { Button } from "../../components/Button"
import { buttonClass } from "../../components/buttonClass"
import { EmptyState } from "../../components/EmptyState"
import { Spinner } from "../../components/Spinner"
import { ApiError } from "../../lib/api"
import { useAssistantEnabled } from "../../lib/config"
import { useAppliedSchema } from "../../lib/schema"
import { locateError, tablesInSql } from "../../lib/sqlText"
import { useWorkspaceContext } from "../workspaces/context"
import { StepHeader } from "../workspaces/StepHeader"
import type { QueryErrorDetail, QueryableTable, SavedQueryOut } from "./api"
import { useRunQuery, useSavedQueries, useSaveQuery, useSourceTables } from "./queries"
import "./query.css"
import { ResultPanel, type RunOutcome } from "./ResultGrid"
import { DeleteSavedQueryDialog, SavedQueries, SaveQueryDialog } from "./SavedQueries"
import { SchemaSidebar } from "./SchemaSidebar"
import type { SqlEditorHandle } from "./SqlEditor"

// CodeMirror is most of this screen's weight; load it with the screen, not with the app.
const SqlEditor = lazy(() => import("./SqlEditor").then((m) => ({ default: m.SqlEditor })))

/** What another screen (History) can hand over: SQL to open, and the saved query it belongs to. */
export interface OpenInEditor {
  sql: string
  savedQueryId?: number | null
}

const SOURCE_NAMES = ["_staging", "_raw"]
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
const RUN_HINT = isMac ? "⌘ Enter" : "Ctrl Enter"

interface Draft {
  sql: string | null
  savedId: number | null
}

const draftKey = (wsId: number) => `qlens:query-draft:${wsId}`

function readDraft(wsId: number): Draft {
  try {
    const raw = localStorage.getItem(draftKey(wsId))
    if (raw) {
      const d = JSON.parse(raw) as Partial<Draft>
      return {
        sql: typeof d.sql === "string" ? d.sql : null,
        savedId: typeof d.savedId === "number" ? d.savedId : null,
      }
    }
  } catch {
    // storage blocked or junk: start fresh
  }
  return { sql: null, savedId: null }
}

export function QueryPage() {
  const { workspace } = useWorkspaceContext()
  if (workspace.stage !== "applied") {
    return (
      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-8 sm:py-12">
        <StepHeader step="query" />
        <EmptyState
          icon={<Lock size={18} strokeWidth={1.5} />}
          title="Apply a design first"
          lanes={[0, 4]}
          action={
            <Link to={`/w/${workspace.id}/design`} className={buttonClass("primary")}>
              Go to Design
            </Link>
          }
        >
          Queries run against the tables your design creates. Once Design applies them (with the lossless check), they
          show up here ready to query.
        </EmptyState>
      </div>
    )
  }
  return <QueryWorkbench wsId={workspace.id} />
}

function QueryWorkbench({ wsId }: { wsId: number }) {
  const location = useLocation()
  const navigate = useNavigate()
  const handed = (location.state as { open?: OpenInEditor } | null)?.open
  const [draft, setDraft] = useState<Draft>(() =>
    handed ? { sql: handed.sql, savedId: handed.savedQueryId ?? null } : readDraft(wsId),
  )
  const [showSource, setShowSource] = useState(false)
  const [outcome, setOutcome] = useState<RunOutcome | null>(null)
  const [dialog, setDialog] = useState<"new" | "rename" | null>(null)
  const [deleting, setDeleting] = useState<SavedQueryOut | null>(null)
  const editor = useRef<SqlEditorHandle>(null)

  const schemaQ = useAppliedSchema(wsId)
  const savedQ = useSavedQueries(wsId)
  const sourceTables = useSourceTables(wsId, true)
  const runM = useRunQuery(wsId)
  const assistantOn = useAssistantEnabled()

  const tables: QueryableTable[] = useMemo(() => schemaQ.data?.tables ?? [], [schemaQ.data])
  const saved = useMemo(() => savedQ.data ?? [], [savedQ.data])
  const loaded = saved.find((q) => q.id === draft.savedId) ?? null

  const starter = tables[0] ? `SELECT *\nFROM ${tables[0].name}\nLIMIT 50;` : ""
  const sql = draft.sql ?? (loaded ? loaded.sql_text : starter)
  const dirty = loaded ? sql !== loaded.sql_text : sql.trim() !== "" && sql !== starter

  // the handed-over SQL is now the draft; drop it from the history entry so a reload keeps later edits
  useEffect(() => {
    if (handed) navigate(location.pathname, { replace: true, state: null })
  }, [handed, navigate, location.pathname])

  useEffect(() => {
    try {
      localStorage.setItem(draftKey(wsId), JSON.stringify(draft))
    } catch {
      // not essential
    }
  }, [wsId, draft])

  const laneOf = useCallback((name: string) => tables.find((t) => t.name === name)?.color_index ?? null, [tables])

  // completion knows the designed tables always, and the sheet tables when they're shown
  const completion = useMemo(() => {
    const out: Record<string, string[]> = {}
    for (const t of [...tables, ...(showSource ? sourceTables : [])]) out[t.name] = t.columns.map((c) => c.name)
    return out
  }, [tables, showSource, sourceTables])

  const run = useCallback(() => {
    const text = sql
    if (!text.trim() || runM.isPending) return
    editor.current?.markError(null)
    const known = [...tables.map((t) => t.name), ...SOURCE_NAMES]
    runM.mutate(
      { sql: text, savedQueryId: loaded && !dirty ? loaded.id : null },
      {
        onSuccess: (r) =>
          setOutcome({
            kind: "ok",
            runId: r.run_id,
            result: r.result,
            tables: tablesInSql(text, known).map((name) => ({ name, lane: laneOf(name) })),
          }),
        onError: (e) => {
          const code = e instanceof ApiError ? e.code : "network_error"
          const detail = (e instanceof ApiError ? e.detail : null) as QueryErrorDetail | null
          const where = locateError(text, detail?.position)
          setOutcome({ kind: "error", key: Date.now(), code, message: e.message, sqlstate: detail?.sqlstate, where })
          if (where) editor.current?.markError(where.offset)
        },
      },
    )
  }, [sql, runM, tables, loaded, dirty, laneOf])

  const setSql = (v: string) => setDraft((d) => ({ ...d, sql: v }))
  const pick = (q: SavedQueryOut) => {
    setDraft({ sql: q.sql_text, savedId: q.id })
    editor.current?.focus()
  }

  if (schemaQ.isPending) {
    return (
      <div className="grid min-h-[50dvh] place-items-center">
        <Spinner size={20} />
      </div>
    )
  }
  if (schemaQ.error) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-8">
        <StepHeader step="query" />
        <EmptyState title="Couldn't read your tables" lanes={[7, 3]}>
          {schemaQ.error.message}
        </EmptyState>
      </div>
    )
  }

  return (
    <div className="px-4 py-8 sm:px-8 sm:py-10">
      <StepHeader
        step="query"
        actions={
          <Link to={`/w/${wsId}/history`} className={buttonClass("ghost", "sm")}>
            <History size={14} />
            History
          </Link>
        }
      >
        Write SQL against your tables. Each query runs read-only as this workspace's own database role, with a 5-second
        limit.
      </StepHeader>

      {/* Reserved for the English-to-SQL assistant (a later task). Nothing renders until /api/config turns it on. */}
      {assistantOn && <div data-slot="assistant" className="mb-5" />}

      <div className="grid gap-6 lg:grid-cols-[244px_minmax(0,1fr)] lg:gap-8">
        <aside className="scrollbar-thin order-2 min-w-0 lg:order-1 lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6.5rem)] lg:self-start lg:overflow-y-auto lg:pr-1">
          <SchemaSidebar
            tables={tables}
            sourceTables={sourceTables}
            showSource={showSource}
            onShowSource={setShowSource}
            onInsert={(text) => editor.current?.insert(text)}
            laneOf={laneOf}
          />
        </aside>

        <div className="order-1 flex min-w-0 flex-col gap-7 lg:order-2">
          <div>
            <SavedQueries
              wsId={wsId}
              saved={saved}
              activeId={loaded?.id ?? null}
              dirty={dirty}
              onPick={pick}
              onNew={() => setDraft({ sql: "", savedId: null })}
            />
            <div className="q-editor overflow-hidden rounded-card border border-border bg-surface">
              <Suspense
                fallback={
                  <div className="grid h-[190px] place-items-center">
                    <Spinner size={16} />
                  </div>
                }
              >
                <SqlEditor
                  ref={editor}
                  value={sql}
                  onChange={setSql}
                  onRun={run}
                  schema={completion}
                  label={loaded ? `SQL of ${loaded.title}` : "SQL query"}
                />
              </Suspense>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border bg-raised px-3 py-2">
                <p className="mr-auto text-[12px] text-faint">Read-only, 5 s limit, first 1,000 rows returned</p>
                {loaded && (
                  <>
                    <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} onClick={() => setDeleting(loaded)}>
                      Delete
                    </Button>
                    <Button variant="ghost" size="sm" icon={<Pencil size={13} />} onClick={() => setDialog("rename")}>
                      Rename
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDialog("new")} disabled={!sql.trim()}>
                      Save as new
                    </Button>
                  </>
                )}
                <SaveButton wsId={wsId} loaded={loaded} dirty={dirty} sql={sql} onNew={() => setDialog("new")} />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={run}
                  disabled={!sql.trim()}
                  loading={runM.isPending}
                  icon={<Play size={13} fill="currentColor" />}
                  title={`Run (${RUN_HINT})`}
                >
                  Run
                  <kbd className="kbd kbd-on-accent hidden sm:inline-flex">{RUN_HINT}</kbd>
                </Button>
              </div>
            </div>
          </div>

          <ResultPanel outcome={outcome} running={runM.isPending} runHint={RUN_HINT} />
        </div>
      </div>

      <SaveQueryDialog
        wsId={wsId}
        mode={dialog}
        current={loaded}
        sqlText={sql}
        onClose={() => setDialog(null)}
        onSaved={(q) => setDraft({ sql: q.sql_text, savedId: q.id })}
      />
      <DeleteSavedQueryDialog
        wsId={wsId}
        query={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => setDraft((d) => ({ ...d, savedId: null }))}
      />
    </div>
  )
}

/** "Save" for a new query; "Save changes" once a saved query is loaded and edited. */
function SaveButton({
  wsId,
  loaded,
  dirty,
  sql,
  onNew,
}: {
  wsId: number
  loaded: SavedQueryOut | null
  dirty: boolean
  sql: string
  onNew: () => void
}) {
  const save = useSaveQuery(wsId)
  if (!loaded) {
    return (
      <Button size="sm" icon={<Save size={13} />} onClick={onNew} disabled={!sql.trim()}>
        Save
      </Button>
    )
  }
  return (
    <Button
      size="sm"
      icon={<Save size={13} />}
      disabled={!dirty || !sql.trim()}
      loading={save.isPending}
      onClick={() => save.mutate({ id: loaded.id, title: loaded.title, sql_text: sql })}
      title={dirty ? "Save the edited SQL into this saved query" : "No changes to save"}
    >
      {dirty ? "Save changes" : "Saved"}
    </Button>
  )
}
