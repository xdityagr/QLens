import "./assistant.css"
import { useQueryClient } from "@tanstack/react-query"
import { ArrowUpRight, MessageSquareText, PanelLeftClose, PanelLeftOpen, Plus, Sparkles } from "lucide-react"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react"
import { useNavigate, useSearchParams } from "react-router"
import { IconButton } from "../../components/Button"
import { NoiseBackdrop } from "../../components/NoiseBackdrop"
import { Spinner } from "../../components/Spinner"
import { Mark } from "../../components/Wordmark"
import { fmtInt, fmtRelative } from "../../lib/format"
import { laneVar } from "../../lib/lanes"
import { useReducedMotion } from "../../lib/reveal"
import type { SchemaTable } from "../../lib/types"
import { historyKey, slowKey } from "../query/queries"
import type { AssistantReply } from "./api"
import { askStarters, chatTitle, groupConversations } from "./askLogic"
import { Composer } from "./Composer"
import { ThreadBody } from "./Conversation"
import type { SqlAction } from "./Thread"
import { useAssistant, useConversations, type Assistant } from "./useAssistant"

const NOTE =
  "Read-only: it runs SELECT queries in a read-only transaction. Questions, table structure and up to 50 result rows are sent to Google Gemini."
const RAIL_PREF = "qlens.ask.rail"

function readRailPref(): boolean {
  try {
    return localStorage.getItem(RAIL_PREF) !== "closed"
  } catch {
    return true
  }
}

const WIDE = "(min-width: 1024px)"
const subscribeWide = (cb: () => void) => {
  const mq = window.matchMedia(WIDE)
  mq.addEventListener("change", cb)
  return () => mq.removeEventListener("change", cb)
}
/** lg and up: the list sits beside the thread; below it, it is a drawer. */
function useWide(): boolean {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches, () => true)
}

/**
 * Ask AI as a page of its own: the conversation list on the left, the thread in a wide centred column, and the
 * composer pinned to the bottom. Conversations here use the "data" context: read-only, never edits the design.
 */
export default function AskChat({ wsId, tables }: { wsId: number; tables: SchemaTable[] }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const reduced = useReducedMotion()
  const input = useRef<HTMLTextAreaElement>(null)

  const onReply = useCallback(
    (r: AssistantReply) => {
      // the assistant's runs are recorded in History (source "From English")
      if (r.sql_runs.length || r.actions.some((x) => x.tool === "run_sql")) {
        void qc.invalidateQueries({ queryKey: historyKey(wsId) })
        void qc.invalidateQueries({ queryKey: slowKey(wsId) })
      }
      return null
    },
    [qc, wsId],
  )
  const a = useAssistant({ wsId, context: "data", onReply })
  const conversations = useConversations(wsId, "data", true)

  // The open conversation lives in the URL (?c=12), so Back from "Open in SQL tab" and a reload return to it.
  const [params, setParams] = useSearchParams()
  const restoring = useRef(true)
  const { openConversation } = a
  useEffect(() => {
    const c = Number(params.get("c"))
    if (!Number.isInteger(c) || c <= 0) {
      restoring.current = false
      return
    }
    void openConversation(c).finally(() => {
      restoring.current = false
    })
    // only on arrival; later changes go the other way
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (restoring.current || a.loading) return
    const want = a.conversationId === null ? null : String(a.conversationId)
    if (params.get("c") === want) return
    setParams(
      (p) => {
        const n = new URLSearchParams(p)
        if (want === null) n.delete("c")
        else n.set("c", want)
        return n
      },
      { replace: true },
    )
  }, [a.conversationId, a.loading, params, setParams])

  const laneOf = useCallback((name: string) => tables.find((t) => t.name === name)?.color_index ?? null, [tables])
  const starters = useMemo(() => askStarters(tables), [tables])
  const sqlAction: SqlAction = useMemo(
    () => ({
      label: "Open in SQL tab",
      icon: <ArrowUpRight size={13} strokeWidth={1.9} />,
      // the Data page takes SQL handed over in router state (as from History and Design's assistant)
      run: (sql) => navigate(`/w/${wsId}/data?tab=sql`, { state: { open: { sql } } }),
    }),
    [navigate, wsId],
  )

  // the list: open by default on wide screens (remembered), a drawer over the page on narrow ones
  const [rail, setRail] = useState(readRailPref)
  const [drawer, setDrawer] = useState(false)
  const isWide = useWide()
  const toggleList = () => {
    if (!isWide) {
      setDrawer((v) => !v)
      return
    }
    setRail((v) => {
      try {
        localStorage.setItem(RAIL_PREF, v ? "closed" : "open")
      } catch {
        // storage blocked; the choice lasts for this visit
      }
      return !v
    })
  }
  const listShown = isWide ? rail : drawer

  const send = (text: string) => {
    a.setDraft("")
    void a.ask(text)
  }
  const newChat = () => {
    a.newChat()
    setDrawer(false)
    input.current?.focus()
  }

  // ---- scrolling: follow the thread while the reader is at the bottom; a new question always goes there
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const toBottom = useCallback((smooth: boolean) => {
    const el = scroller.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" })
  }, [])
  useLayoutEffect(() => {
    if (a.pending !== null) {
      atBottom.current = true
      toBottom(!reduced)
    }
  }, [a.pending, reduced, toBottom])
  const empty = a.turns.length === 0 && a.pending === null && !a.loading
  useLayoutEffect(() => {
    // an opened conversation starts at its latest answer; the empty page starts at its top
    atBottom.current = true
    if (!empty) toBottom(false)
  }, [a.conversationId, a.loading, empty, toBottom])
  useEffect(() => {
    // the reply grows while the typewriter runs and when its tables arrive
    const el = content.current
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => {
      if (atBottom.current) toBottom(false)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [toBottom, empty])
  const current = conversations.data?.find((c) => c.id === a.conversationId)
  const title = chatTitle(current?.title, a.turns.find((t) => t.role === "user")?.text)

  return (
    <div
      className="relative flex h-[calc(100dvh-3.5rem-46px)] min-h-[420px] md:h-[calc(100dvh-3.5rem)]"
      onKeyDown={(e) => {
        if (e.key === "Escape" && drawer && !e.defaultPrevented) {
          e.preventDefault()
          setDrawer(false)
        }
      }}
    >
      {/* narrow screens: the list is a drawer, and a tap beside it closes it */}
      {drawer && !isWide && (
        <button
          type="button"
          aria-label="Close the conversation list"
          className="ask-scrim fixed inset-0 top-14 z-40 bg-[color-mix(in_oklab,var(--bg)_60%,transparent)] lg:hidden"
          onClick={() => setDrawer(false)}
        />
      )}
      <ConversationRail
        a={a}
        open={rail}
        drawer={drawer && !isWide}
        list={conversations}
        onNew={newChat}
        onPick={(id) => {
          setDrawer(false)
          void a.openConversation(id)
        }}
      />

      <section aria-label="Ask AI" className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-2 sm:px-3">
          <IconButton
            label={listShown ? "Hide conversations" : "Show conversations"}
            aria-expanded={listShown}
            onClick={toggleList}
          >
            {listShown ? (
              <PanelLeftClose size={16} strokeWidth={1.75} />
            ) : (
              <PanelLeftOpen size={16} strokeWidth={1.75} />
            )}
          </IconButton>
          <h2
            key={title}
            className="ask-title mr-auto min-w-0 truncate pl-1 text-[14px] font-medium tracking-[-0.01em] text-text"
            title={title}
          >
            {title}
          </h2>
          <span className="hidden shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11.5px] text-muted sm:inline-flex">
            <span aria-hidden className="size-1.5 rounded-full bg-lane-4" />
            Read-only
          </span>
          <IconButton label="New chat" onClick={newChat} disabled={a.pending !== null || empty}>
            <Plus size={16} strokeWidth={1.75} />
          </IconButton>
        </header>

        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}
          className="scrollbar-thin relative min-h-0 flex-1 overflow-y-auto"
        >
          {empty ? (
            <Hero tables={tables} starters={starters} busy={a.pending !== null} onAsk={send} />
          ) : (
            <div ref={content} className="mx-auto w-full max-w-[880px] px-4 pb-10 pt-8 sm:px-8">
              <ThreadBody a={a} laneOf={laneOf} sqlAction={sqlAction} layout="page" empty={null} />
            </div>
          )}
        </div>

        <div className="relative shrink-0 bg-bg">
          {/* the thread fades out under the composer instead of being cut off by a line */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 -top-8 h-8 bg-gradient-to-t from-[var(--bg)] to-transparent"
          />
          <div className="mx-auto w-full max-w-[880px] px-3 pb-3 pt-1 sm:px-8 sm:pb-4">
            <Composer
              value={a.draft}
              onChange={a.setDraft}
              onSubmit={send}
              pending={a.pending}
              inputRef={input}
              label={a.turns.length ? "Ask a follow-up" : "Ask a question about your data"}
              placeholder={a.turns.length ? "Ask a follow-up…" : "Ask a question about your tables…"}
              note={NOTE}
            />
          </div>
        </div>
      </section>
    </div>
  )
}

/** The empty page: what can be asked, about which tables, and a few questions to start from. */
function Hero({
  tables,
  starters,
  busy,
  onAsk,
}: {
  tables: SchemaTable[]
  starters: string[]
  busy: boolean
  onAsk: (q: string) => void
}) {
  return (
    <div className="relative isolate flex min-h-full items-center justify-center overflow-hidden px-4 py-10 sm:px-8">
      <NoiseBackdrop lanes={[0, 1]} intensity={0.14} placement="center" animated />
      <div className="relative mx-auto flex w-full max-w-[760px] flex-col items-center text-center">
        <div className="ask-rise mb-5 grid size-12 place-items-center rounded-2xl border border-border-strong bg-raised">
          <Mark size={22} />
        </div>
        <h2
          className="ask-rise text-[28px] font-medium leading-tight tracking-[-0.035em] text-text sm:text-[36px]"
          style={{ "--i": 1 } as CSSProperties}
        >
          Ask anything about your data
        </h2>
        <p
          className="ask-rise mt-3 max-w-[58ch] text-[15px] leading-relaxed text-muted"
          style={{ "--i": 2 } as CSSProperties}
        >
          Plain English in, rows out. The assistant writes one SELECT against these tables, runs it read-only and
          answers with the rows and the SQL it used.
        </p>

        {tables.length > 0 && (
          <ul aria-label="Tables" className="mt-6 flex flex-wrap justify-center gap-2">
            {tables.map((t, i) => (
              <li
                key={t.name}
                className="as-chip inline-flex h-8 items-center gap-2 rounded-full border border-border bg-[color-mix(in_oklab,var(--surface)_80%,transparent)] px-3 text-[12.5px]"
                style={{ "--i": i + 3 } as CSSProperties}
              >
                <span aria-hidden className="size-2 rounded-full" style={{ background: laneVar(t.color_index) }} />
                <span className="font-mono text-text">{t.name}</span>
                <span className="num text-faint">{fmtInt(t.row_count)}</span>
              </li>
            ))}
          </ul>
        )}

        {starters.length > 0 && (
          <div className="mt-9 w-full">
            <p className="mb-3 flex items-center justify-center gap-1.5 text-[12.5px] text-muted">
              <Sparkles size={13} strokeWidth={1.75} className="text-lane-1" aria-hidden />
              Start with one of these
            </p>
            <ul className="grid gap-2.5 text-left sm:grid-cols-2">
              {starters.map((q, i) => (
                <li key={q} className="as-chip" style={{ "--i": i + 4 } as CSSProperties}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onAsk(q)}
                    className="ask-starter group flex h-full w-full items-start gap-3 text-left rounded-card border border-border bg-[color-mix(in_oklab,var(--surface)_86%,transparent)] px-4 py-3.5 text-[14px] leading-snug text-text disabled:opacity-50"
                  >
                    <span
                      aria-hidden
                      className="mt-[5px] size-2 shrink-0 rounded-full"
                      style={{ background: laneVar(i % 8) }}
                    />
                    <span className="flex-1">{q}</span>
                    <ArrowUpRight
                      size={15}
                      strokeWidth={1.75}
                      aria-hidden
                      className="ask-starter-arrow mt-0.5 shrink-0 text-faint"
                    />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

/** Earlier conversations of this page, grouped by day, with New chat on top. */
function ConversationRail({
  a,
  open,
  drawer,
  list,
  onNew,
  onPick,
}: {
  a: Assistant
  open: boolean
  drawer: boolean
  list: ReturnType<typeof useConversations>
  onNew: () => void
  onPick: (id: number) => void
}) {
  const groups = useMemo(() => groupConversations(list.data ?? []), [list.data])
  return (
    <aside aria-label="Conversations" data-rail={open} data-drawer={drawer} className="ask-rail border-r border-border">
      <div className="flex h-full w-[264px] max-w-full flex-col">
        <div className="shrink-0 p-3">
          <button
            type="button"
            onClick={onNew}
            disabled={a.pending !== null}
            className="flex h-10 w-full items-center gap-2.5 rounded-control border border-border-strong bg-raised px-3 text-[13.5px] font-medium text-text transition-[background-color,transform] duration-150 hover:bg-hover active:scale-[0.98] disabled:opacity-50"
          >
            <Plus size={15} strokeWidth={2} />
            New chat
          </button>
        </div>
        <nav aria-label="Earlier conversations" className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {list.isPending && (
            <div className="grid h-16 place-items-center text-muted">
              <Spinner size={15} />
            </div>
          )}
          {list.error && <p className="px-3 py-3 text-[12.5px] text-danger">{list.error.message}</p>}
          {list.data?.length === 0 && (
            <p className="flex items-start gap-2 px-3 py-3 text-[12.5px] leading-relaxed text-muted">
              <MessageSquareText size={14} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden />
              Questions you ask are kept here, so you can come back to an answer.
            </p>
          )}
          {groups.map((g) => (
            <div key={g.label} className="mt-2 first:mt-0">
              <p className="px-3 pb-1 pt-2 text-[11.5px] font-medium text-faint">{g.label}</p>
              <ul className="flex flex-col gap-px">
                {g.items.map((c) => {
                  const on = c.id === a.conversationId
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        aria-current={on ? "true" : undefined}
                        disabled={a.pending !== null}
                        onClick={() => onPick(c.id)}
                        className={
                          "relative flex w-full flex-col items-start gap-0.5 rounded-control px-3 py-2 text-left transition-colors duration-150 disabled:opacity-60 " +
                          (on ? "bg-hover" : "hover:bg-[color-mix(in_oklab,var(--hover)_70%,transparent)]")
                        }
                      >
                        {on && (
                          <span aria-hidden className="ask-mark absolute bottom-2 left-0 top-2 w-[2px] rounded-full bg-accent" />
                        )}
                        <span className={"w-full truncate text-[13px] " + (on ? "text-text" : "text-muted")}>
                          {c.title}
                        </span>
                        <span className="text-[11px] text-faint">
                          {fmtRelative(c.updated_at)} · {c.message_count}{" "}
                          {c.message_count === 1 ? "message" : "messages"}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </nav>
      </div>
    </aside>
  )
}
