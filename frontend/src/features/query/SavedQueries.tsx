import { FilePlus2 } from "lucide-react"
import { useEffect, useRef, useState, type FormEvent } from "react"
import { Button } from "../../components/Button"
import { Dialog } from "../../components/Dialog"
import { Field } from "../../components/Field"
import { Sparkline } from "../../components/Sparkline"
import { ApiError } from "../../lib/api"
import { fmtMs } from "../../lib/format"
import { FormError } from "../auth/bits"
import type { SavedQueryOut } from "./api"
import { useDeleteSavedQuery, useSaveQuery, useTrend } from "./queries"

/**
 * Saved queries as a strip of tabs over the editor. Each shows how often it ran and how its timing moved
 * (v_saved_query_trend). Picking one loads it into the editor; the first tab is the unsaved scratch query.
 */
export function SavedQueries({
  wsId,
  saved,
  activeId,
  dirty,
  onPick,
  onNew,
}: {
  wsId: number
  saved: SavedQueryOut[]
  activeId: number | null
  dirty: boolean
  onPick: (q: SavedQueryOut) => void
  onNew: () => void
}) {
  return (
    <div
      role="group"
      aria-label="Saved queries"
      className="scrollbar-thin -mb-px flex items-end gap-1 overflow-x-auto px-1 pt-1"
    >
      <button
        type="button"
        onClick={onNew}
        aria-pressed={activeId === null}
        className={tabClass(activeId === null)}
        title="Start a new, unsaved query"
      >
        <span className="flex items-center gap-1.5 text-[13px]">
          <FilePlus2 size={13} className="text-muted" />
          {activeId === null ? "Unsaved query" : "New query"}
        </span>
        <span className="text-[11.5px] text-faint">{activeId === null && dirty ? "Not saved yet" : "Start blank"}</span>
      </button>
      {saved.map((q) => (
        <SavedTab
          key={q.id}
          wsId={wsId}
          q={q}
          active={q.id === activeId}
          dirty={dirty && q.id === activeId}
          onPick={onPick}
        />
      ))}
    </div>
  )
}

function tabClass(active: boolean) {
  return (
    "relative flex min-w-[148px] max-w-[220px] shrink-0 flex-col items-start gap-0.5 rounded-t-card border border-b-0 px-3 pb-2 pt-2 text-left " +
    "transition-[background-color,border-color,color] duration-150 " +
    (active
      ? "z-[1] border-border bg-surface text-text"
      : "border-transparent text-muted hover:bg-hover hover:text-text")
  )
}

function SavedTab({
  wsId,
  q,
  active,
  dirty,
  onPick,
}: {
  wsId: number
  q: SavedQueryOut
  active: boolean
  dirty: boolean
  onPick: (q: SavedQueryOut) => void
}) {
  const { data: trend } = useTrend(wsId, q.id, q.run_count)
  const values = (trend ?? []).slice(-20).map((p) => p.duration_ms)
  const label =
    values.length > 1
      ? `Last ${values.length} runs took between ${fmtMs(Math.min(...values))} and ${fmtMs(Math.max(...values))}`
      : undefined
  return (
    <button type="button" onClick={() => onPick(q)} aria-pressed={active} className={tabClass(active)} title={q.title}>
      {active && <span aria-hidden className="absolute inset-x-3 top-0 h-[2px] rounded-b-full bg-accent" />}
      <span className="flex w-full min-w-0 items-center gap-1.5 text-[13px]">
        <span className="min-w-0 truncate">{q.title}</span>
        {dirty && (
          <span
            aria-label="edited"
            title="Edited since it was saved"
            className="size-1.5 shrink-0 rounded-full bg-lane-3"
          />
        )}
      </span>
      <span className="flex w-full items-center gap-2 text-[11.5px] text-faint">
        <span className="num">
          {q.run_count} {q.run_count === 1 ? "run" : "runs"}
        </span>
        {q.last_duration_ms !== null && <span className="num">{fmtMs(q.last_duration_ms)}</span>}
        {values.length > 0 && (
          <Sparkline
            values={values}
            width={44}
            height={14}
            label={label}
            color={active ? "var(--accent)" : "var(--muted)"}
            className="ml-auto"
          />
        )}
      </span>
    </button>
  )
}

/**
 * Names a query: saving a new one ("new"), or renaming the loaded one ("rename", which also saves the
 * editor's current text into it).
 */
export function SaveQueryDialog({
  wsId,
  mode,
  current,
  sqlText,
  onClose,
  onSaved,
}: {
  wsId: number
  mode: "new" | "rename" | null
  current: SavedQueryOut | null
  sqlText: string
  onClose: () => void
  onSaved: (q: SavedQueryOut) => void
}) {
  const save = useSaveQuery(wsId)
  const [title, setTitle] = useState("")
  const [lastMode, setLastMode] = useState(mode)
  const input = useRef<HTMLInputElement>(null)
  // showModal() moves focus to the dialog's first control (Close); put it in the title field instead
  useEffect(() => {
    if (mode === null) return
    const raf = requestAnimationFrame(() => input.current?.select())
    return () => cancelAnimationFrame(raf)
  }, [mode])
  // a fresh title each time the dialog opens: the query's own name when renaming
  if (mode !== lastMode) {
    setLastMode(mode)
    setTitle(mode === "rename" && current ? current.title : "")
  }

  function close() {
    save.reset()
    onClose()
  }
  function submit(e: FormEvent) {
    e.preventDefault()
    const t = title.trim()
    if (!t) return
    save.mutate(
      { id: mode === "rename" ? current?.id : undefined, title: t, sql_text: sqlText },
      {
        onSuccess: (q) => {
          close()
          onSaved(q)
        },
      },
    )
  }
  const err = save.error
  const titleError =
    err instanceof ApiError && err.code === "title_taken" ? "You already have a saved query with this title." : null

  return (
    <Dialog
      open={mode !== null}
      onClose={close}
      title={mode === "rename" ? "Rename saved query" : "Save query"}
      description={
        mode === "rename"
          ? "Renaming also saves the SQL that is in the editor now."
          : "Saved queries keep their run count and timing trend, so you can see if a query gets slower."
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-5">
        <Field
          label="Title"
          placeholder="Fees collected per batch"
          ref={input}
          required
          maxLength={80}
          value={title}
          error={titleError}
          onChange={(e) => setTitle(e.target.value)}
        />
        <FormError message={err && !titleError ? err.message : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!title.trim()}>
            {mode === "rename" ? "Rename and save" : "Save query"}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

export function DeleteSavedQueryDialog({
  wsId,
  query,
  onClose,
  onDeleted,
}: {
  wsId: number
  query: SavedQueryOut | null
  onClose: () => void
  onDeleted: () => void
}) {
  const del = useDeleteSavedQuery(wsId)
  function close() {
    del.reset()
    onClose()
  }
  return (
    <Dialog
      open={query !== null}
      onClose={close}
      title={`Delete "${query?.title ?? ""}"?`}
      description="The saved query and its timing trend go. Its past runs stay in History."
    >
      <FormError message={del.error?.message} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="danger"
          loading={del.isPending}
          onClick={() =>
            query &&
            del.mutate(query.id, {
              onSuccess: () => {
                close()
                onDeleted()
              },
            })
          }
        >
          Delete saved query
        </Button>
      </div>
    </Dialog>
  )
}
