import { Footprints, Gauge, Pencil, Play, Save, Trash2, X } from "lucide-react"
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Button, IconButton } from "../../components/Button"
import { Spinner } from "../../components/Spinner"
import { ApiError } from "../../lib/api"
import { useAppliedSchema } from "../../lib/schema"
import { starterSnippets, type Snippet } from "../../lib/snippets"
import { statementInfo, type StatementInfo } from "../../lib/sqlKind"
import { locateError, tablesInSql } from "../../lib/sqlText"
import type { QueryErrorDetail, QueryableTable, SavedQueryOut } from "../query/api"
import { useRunQuery, useSavedQueries, useSaveQuery, useSourceTables } from "../query/queries"
import "../query/query.css"
import { ResultPanel, type RunOutcome } from "../query/ResultGrid"
import { DeleteSavedQueryDialog, SaveQueryDialog } from "../query/SavedQueries"
import type { SqlEditorHandle } from "../query/SqlEditor"
import { constraintDetail, type SqlWriteOut } from "./api"
import { ConstraintCard } from "./ConstraintCard"
import { useSqlWrite } from "./queries"
import { SqlSide } from "./SqlSide"
import { ConfirmWrite, WriteResult } from "./WriteParts"

// CodeMirror is most of this tab's weight; it loads when the tab is first opened.
const SqlEditor = lazy(() => import("../query/SqlEditor").then((m) => ({ default: m.SqlEditor })))
// The two "look inside" panels load the first time one is opened.
const ExplainPanel = lazy(() => import("../perf/ExplainPanel").then((m) => ({ default: m.ExplainPanel })))
const StepThrough = lazy(() => import("../query/StepThrough").then((m) => ({ default: m.StepThrough })))

/** SQL another screen hands over (History, the assistant): opened as the editor's text. */
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

// the same key the old Query screen used, so an unsaved query survives the move
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

type Outcome =
  RunOutcome | { kind: "write"; runId: number; out: SqlWriteOut } | { kind: "refused"; key: number; error: Error }

type Panel = "explain" | "step"

/**
 * The SQL tab: an editor for the applied tables. A SELECT runs read-only, as before; a single INSERT, UPDATE or
 * DELETE runs after a confirm, in one transaction, and the audit trigger records it. After a SELECT, the plan
 * ("Explain & speed up") and the clause-by-clause step-through open under the results.
 */
export function SqlTab({ wsId, incoming }: { wsId: number; incoming: OpenInEditor | null }) {
  const [draft, setDraft] = useState<Draft>(() =>
    incoming ? { sql: incoming.sql, savedId: incoming.savedQueryId ?? null } : readDraft(wsId),
  )
  const [showSource, setShowSource] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [ranSql, setRanSql] = useState<string | null>(null) // the SELECT the panels look at
  const [panels, setPanels] = useState<Set<Panel>>(new Set())
  const [confirming, setConfirming] = useState<{ sql: string; info: StatementInfo } | null>(null)
  const [dialog, setDialog] = useState<"new" | "rename" | null>(null)
  const [deleting, setDeleting] = useState<SavedQueryOut | null>(null)
  const editor = useRef<SqlEditorHandle>(null)

  const schemaQ = useAppliedSchema(wsId)
  const savedQ = useSavedQueries(wsId)
  const sourceTables = useSourceTables(wsId, true)
  const runM = useRunQuery(wsId)
  const writeM = useSqlWrite(wsId)

  const tables: QueryableTable[] = useMemo(() => schemaQ.data?.tables ?? [], [schemaQ.data])
  const snippets = useMemo(() => starterSnippets(schemaQ.data?.tables ?? []), [schemaQ.data])
  const saved = useMemo(() => savedQ.data ?? [], [savedQ.data])
  const loaded = saved.find((q) => q.id === draft.savedId) ?? null

  const starter = tables[0] ? `SELECT *\nFROM ${tables[0].name}\nLIMIT 50;` : ""
  const sql = draft.sql ?? (loaded ? loaded.sql_text : starter)
  const dirty = loaded ? sql !== loaded.sql_text : sql.trim() !== "" && sql !== starter
  const info = useMemo(() => statementInfo(sql), [sql])

  // SQL handed over while the tab is open (Ask AI's "Open in SQL tab", History)
  const lastIncoming = useRef(incoming)
  useEffect(() => {
    if (!incoming || incoming === lastIncoming.current) return
    lastIncoming.current = incoming
    setDraft({ sql: incoming.sql, savedId: incoming.savedQueryId ?? null })
    setConfirming(null)
    editor.current?.focus()
  }, [incoming])

  useEffect(() => {
    try {
      localStorage.setItem(draftKey(wsId), JSON.stringify(draft))
    } catch {
      // not essential
    }
  }, [wsId, draft])

  const laneOf = useCallback((name: string) => tables.find((t) => t.name === name)?.color_index ?? null, [tables])

  const completion = useMemo(() => {
    const out: Record<string, string[]> = {}
    for (const t of [...tables, ...(showSource ? sourceTables : [])]) out[t.name] = t.columns.map((c) => c.name)
    return out
  }, [tables, showSource, sourceTables])

  const showError = useCallback((text: string, e: Error) => {
    const code = e instanceof ApiError ? e.code : "network_error"
    const detail = (e instanceof ApiError ? e.detail : null) as QueryErrorDetail | null
    const where = locateError(text, detail?.position)
    setOutcome({ kind: "error", key: Date.now(), code, message: e.message, sqlstate: detail?.sqlstate, where })
    if (where) editor.current?.markError(where.offset)
  }, [])

  const runSelect = useCallback(
    (text: string) => {
      const known = [...tables.map((t) => t.name), ...SOURCE_NAMES]
      runM.mutate(
        { sql: text, savedQueryId: loaded && !dirty ? loaded.id : null },
        {
          onSuccess: (r) => {
            setOutcome({
              kind: "ok",
              runId: r.run_id,
              result: r.result,
              tables: tablesInSql(text, known).map((name) => ({ name, lane: laneOf(name) })),
            })
            setRanSql(text)
          },
          onError: (e) => showError(text, e),
        },
      )
    },
    [runM, tables, loaded, dirty, laneOf, showError],
  )

  const runWrite = useCallback(
    (text: string) => {
      writeM.mutate(text, {
        onSuccess: (out) => {
          setConfirming(null)
          setOutcome({ kind: "write", runId: out.run_id, out })
        },
        onError: (e) => {
          setConfirming(null)
          // a constraint the database enforced gets the same card as Browse; anything else the usual error panel
          if (constraintDetail(e)) {
            setOutcome({ kind: "refused", key: Date.now(), error: e })
            const pos = (e as ApiError).detail as { position?: number | null }
            const where = locateError(text, pos?.position)
            if (where) editor.current?.markError(where.offset)
          } else showError(text, e)
        },
      })
    },
    [writeM, showError],
  )

  // Run: a SELECT runs at once; anything else first asks, then goes to the write path, whose checks say why not.
  const run = useCallback(() => {
    const text = sql
    if (!text.trim() || runM.isPending || writeM.isPending) return
    editor.current?.markError(null)
    if (info.kind === "select" || info.kind === "empty") runSelect(text)
    // everything else asks first; the server decides what may actually run
    else setConfirming({ sql: text, info })
  }, [sql, info, runM.isPending, writeM.isPending, runSelect])

  const setSql = (v: string) => {
    setDraft((d) => ({ ...d, sql: v }))
    if (confirming) setConfirming(null) // the confirm was for the old text
  }
  const pick = (q: SavedQueryOut) => {
    setDraft({ sql: q.sql_text, savedId: q.id })
    setConfirming(null)
    editor.current?.focus()
  }
  const openSql = (text: string) => {
    if (text === sql) return
    // an untouched example is not work to lose; anything else typed and unsaved is
    const untouched = snippets.some((s) => s.sql === sql)
    if (dirty && !untouched && sql.trim() && !window.confirm("Replace the unsaved SQL in the editor?")) return
    setDraft({ sql: text, savedId: null })
    setConfirming(null)
    editor.current?.focus()
  }
  const togglePanel = (p: Panel) =>
    setPanels((s) => {
      const n = new Set(s)
      if (n.has(p)) n.delete(p)
      else n.add(p)
      return n
    })

  if (schemaQ.isPending)
    return (
      <div className="grid min-h-[40dvh] place-items-center">
        <Spinner size={20} />
      </div>
    )

  // anything but a read goes through the confirm card first
  const writing = info.kind !== "select" && info.kind !== "empty"
  const busy = runM.isPending || writeM.isPending
  // the plan and the step-through are for SELECTs: hidden while the editor holds a write
  const showPanels = outcome?.kind === "ok" && ranSql !== null && !writing

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_268px] lg:gap-8">
      <div className="flex min-w-0 flex-col gap-6">
        <SnippetStrip snippets={snippets} onPick={(s) => openSql(s.sql)} active={sql} />

        <div className="q-editor overflow-hidden rounded-card border border-border bg-surface">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <p className="min-w-0 truncate text-[13px] text-text">{loaded ? loaded.title : "Unsaved query"}</p>
            {loaded && dirty && (
              <span title="Edited since it was saved" className="text-[11.5px] text-lane-3">
                edited
              </span>
            )}
            <span className="ml-auto">
              <KindPill info={info} />
            </span>
          </div>
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
              label={loaded ? `SQL of ${loaded.title}` : "SQL"}
            />
          </Suspense>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border bg-raised px-3 py-2">
            <p className="mr-auto text-[12px] text-faint">
              {writing
                ? "Changes data after you confirm. One statement, one transaction, 5 s limit."
                : "A SELECT runs read-only, 5 s limit, first 1,000 rows."}
            </p>
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
              disabled={!sql.trim() || confirming !== null}
              loading={busy}
              icon={<Play size={13} fill="currentColor" />}
              title={`${writing ? "Check and run" : "Run"} (${RUN_HINT})`}
            >
              {writing ? `Run ${info.keyword}…` : "Run"}
              <kbd className="kbd kbd-on-accent hidden sm:inline-flex">{RUN_HINT}</kbd>
            </Button>
          </div>
        </div>

        {confirming && (
          <ConfirmWrite
            info={confirming.info}
            lane={confirming.info.table ? laneOf(confirming.info.table) : null}
            running={writeM.isPending}
            onRun={() => runWrite(confirming.sql)}
            onCancel={() => {
              setConfirming(null)
              editor.current?.focus()
            }}
          />
        )}

        {outcome?.kind === "write" ? (
          <WriteResult key={outcome.runId} out={outcome.out} lane={laneOf(outcome.out.table)} />
        ) : outcome?.kind === "refused" ? (
          <ConstraintCard key={outcome.key} error={outcome.error} onDismiss={() => setOutcome(null)} />
        ) : (
          <ResultPanel outcome={outcome} running={runM.isPending} runHint={RUN_HINT} />
        )}

        {showPanels && (
          <section aria-label="Look inside the query" className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <PanelToggle on={panels.has("explain")} onClick={() => togglePanel("explain")} icon={<Gauge size={14} />}>
                Explain & speed up
              </PanelToggle>
              <PanelToggle on={panels.has("step")} onClick={() => togglePanel("step")} icon={<Footprints size={14} />}>
                Step through
              </PanelToggle>
              <p className="text-[12.5px] text-faint">for the query you just ran</p>
            </div>
            <Suspense fallback={<Spinner size={16} />}>
              {panels.has("explain") && (
                <div className="dw-panel">
                  <ExplainPanel wsId={wsId} sql={ranSql} onClose={() => togglePanel("explain")} />
                </div>
              )}
              {panels.has("step") && (
                <div className="dw-panel rounded-card border border-border bg-surface p-4 sm:p-5">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-[15px] font-medium text-text">Step through</h3>
                      <p className="text-[12.5px] text-muted">
                        The query clause by clause, in the order PostgreSQL applies them.
                      </p>
                    </div>
                    <IconButton label="Close the step-through" onClick={() => togglePanel("step")}>
                      <X size={15} />
                    </IconButton>
                  </div>
                  <StepThrough key={ranSql} wsId={wsId} sql={ranSql} />
                </div>
              )}
            </Suspense>
          </section>
        )}
      </div>

      <aside className="scrollbar-thin min-w-0 lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6.5rem)] lg:self-start lg:overflow-y-auto lg:pr-1">
        <SqlSide
          wsId={wsId}
          tables={tables}
          sourceTables={sourceTables}
          showSource={showSource}
          onShowSource={setShowSource}
          laneOf={laneOf}
          onInsert={(text) => editor.current?.insert(text)}
          saved={saved}
          activeId={loaded?.id ?? null}
          dirty={dirty}
          onPick={pick}
          onNew={() => {
            setDraft({ sql: "", savedId: null })
            setConfirming(null)
          }}
          onRename={(q) => {
            pick(q)
            setDialog("rename")
          }}
          onDelete={setDeleting}
          onOpenSql={openSql}
        />
      </aside>

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
        onDeleted={() => setDraft((d) => (d.savedId === deleting?.id ? { ...d, savedId: null } : d))}
      />
    </div>
  )
}

const KIND_LABEL: Record<string, { text: string; tone: string }> = {
  select: { text: "Reads", tone: "var(--muted)" },
  insert: { text: "Adds rows", tone: "var(--lane-4)" },
  update: { text: "Changes rows", tone: "var(--lane-1)" },
  delete: { text: "Deletes rows", tone: "var(--danger)" },
  other: { text: "Not allowed here", tone: "var(--lane-3)" },
}

/** What the statement in the editor will do, read off its first keyword as you type. */
function KindPill({ info }: { info: StatementInfo }) {
  const k = KIND_LABEL[info.kind]
  if (!k) return null
  return (
    <span
      key={info.kind}
      className="dw-kind inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[12px]"
      style={{ color: k.tone, borderColor: `color-mix(in oklab, ${k.tone} 35%, transparent)` }}
    >
      <span aria-hidden className="size-1.5 rounded-full" style={{ background: k.tone }} />
      {k.text}
      {info.table && <span className="font-mono text-[11.5px] text-muted">{info.table}</span>}
    </span>
  )
}

function PanelToggle({
  on,
  onClick,
  icon,
  children,
}: {
  on: boolean
  onClick: () => void
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={
        "inline-flex h-8 items-center gap-2 rounded-full border px-3.5 text-[13px] transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.97] " +
        (on
          ? "border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_12%,transparent)] text-text"
          : "border-border-strong text-muted hover:bg-hover hover:text-text")
      }
    >
      {icon}
      {children}
    </button>
  )
}

/** Example queries written for these tables. Picking one puts it in the editor; nothing runs until Run. */
function SnippetStrip({
  snippets,
  onPick,
  active,
}: {
  snippets: Snippet[]
  onPick: (s: Snippet) => void
  active: string
}) {
  if (!snippets.length) return null
  return (
    <section aria-labelledby="snippets-h">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id="snippets-h" className="text-[14px] font-medium text-text">
          Examples for your tables
        </h3>
        <p className="text-[12.5px] text-muted">Pick one to put it in the editor. Nothing runs until you press Run.</p>
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {snippets.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => onPick(s)}
              title={s.note}
              aria-pressed={active === s.sql}
              className={
                "inline-flex h-8 items-center gap-2 rounded-control border px-3 text-[13px] transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.98] " +
                (active === s.sql
                  ? "border-border-strong bg-raised text-text"
                  : "border-border text-muted hover:border-border-strong hover:bg-hover hover:text-text")
              }
            >
              {s.title}
              {s.changesData && (
                <span className="rounded-full border border-[color-mix(in_oklab,var(--lane-3)_40%,transparent)] px-1.5 text-[11px] leading-[18px] text-lane-3">
                  changes data
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
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
