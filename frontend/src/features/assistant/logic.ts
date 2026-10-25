// The assistant's pure parts: how tool calls read as chips, whether a reply opens the sidebar or
// toasts, what an edit changed, how errors read, and the example prompts. All tested.

import { ApiError } from "../../lib/api"
import type { DesignChange } from "../../lib/proposalDiff"
import type { TableOut } from "../../lib/types"
import type { AssistantAction, AssistantContext, ConversationDetail, Intent, SqlRun } from "./api"
import { isSqlBlock, parseMarkdown } from "./mdParse"

export type ChipTone = "read" | "check" | "sql" | "edit" | "fail"

export interface Chip {
  label: string
  tone: ChipTone
  /** why it failed, for a failed call */
  detail?: string
}

export interface FriendlyError {
  kind: "rate" | "off" | "upstream" | "network" | "conversation" | "other"
  title: string
  message: string
}

/** One entry of the thread, from a live reply or a stored conversation. */
export interface Turn {
  key: string
  role: "user" | "assistant"
  text: string
  intent?: Intent
  chips: Chip[]
  sqlRuns: SqlRun[]
  /** shown with the typewriter the first time (a reply that just arrived) */
  fresh: boolean
  error?: FriendlyError
}

export const EDIT_TOOLS = new Set([
  "rename_table",
  "rename_column",
  "set_dependency_accepted",
  "rebuild_design",
  "undo_last_edit",
])

// ---- chips ------------------------------------------------------------------------------------

interface CallLike {
  tool: string
  args: Record<string, unknown>
  ok: boolean
  summary?: string
  /** stored tool calls carry the raw result instead of a summary */
  result?: unknown
  error?: string | null
}

const str = (v: unknown) => (typeof v === "string" ? v : "")
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : [])
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {})
const rows = (n: string) => `${n} ${n === "1" ? "row" : "rows"}`

function dep(args: Record<string, unknown>, result?: Record<string, unknown>) {
  const lhs = list(result?.lhs ?? args.lhs)
  const rhs = str(result?.rhs ?? args.rhs)
  return `${lhs.join(" + ")} → ${rhs}`
}

export function chipFor(call: CallLike): Chip {
  const { tool, args, ok } = call
  const summary = call.summary ?? ""
  const result = rec(call.result)
  if (!ok) {
    const detail = call.error ?? summary.replace(/^[a-z_]+ failed:\s*/, "")
    const label =
      tool === "rename_table"
        ? `Couldn't rename ${str(args.table)}`
        : tool === "rename_column"
          ? `Couldn't rename ${str(args.table)}.${str(args.column)}`
          : tool === "run_sql"
            ? "Query failed"
            : tool === "explain_query"
              ? "Couldn't explain the query"
              : tool === "check_dependency"
                ? `Couldn't check ${dep(args)}`
                : tool === "set_dependency_accepted"
                  ? `Couldn't change ${dep(args)}`
                  : tool === "undo_last_edit"
                    ? "Nothing to undo"
                    : `${tool.replace(/_/g, " ")} failed`
    return { label, tone: "fail", detail: detail || undefined }
  }
  switch (tool) {
    case "check_dependency": {
      let verdict = ""
      const broken = /broken in (\d+) rows?/.exec(summary)
      if (/holds in every row/.test(summary)) verdict = "exact"
      else if (broken) verdict = `broken in ${broken[1]} rows`
      else if (result.exact === true) verdict = "exact"
      else if (typeof result.violating_rows === "number") verdict = `broken in ${result.violating_rows} rows`
      return {
        label: `Checked ${dep(args, call.result ? result : undefined)}${verdict ? `: ${verdict}` : ""}`,
        tone: "check",
      }
    }
    case "run_sql": {
      const m = /\((\d+\+?) rows?\)/.exec(summary)
      const n = m
        ? m[1]
        : typeof result.row_count === "number"
          ? `${result.row_count}${result.truncated ? "+" : ""}`
          : ""
      return { label: n ? `Ran a query: ${rows(n)}` : "Ran a query", tone: "sql" }
    }
    case "explain_query": {
      const m = /\(([^,)]+)/.exec(summary)
      const nodes = Array.isArray(result.nodes) ? result.nodes : []
      const top = m?.[1] ?? str(rec(nodes[0]).node)
      return { label: top ? `Explained a query: ${top}` : "Explained a query", tone: "sql" }
    }
    case "describe_schema":
      return { label: "Read the schema", tone: "read" }
    case "list_dependencies": {
      const deps = Array.isArray(result.dependencies) ? result.dependencies.length : null
      return {
        label: summary || (deps !== null ? `Listed ${deps} dependencies` : "Listed the dependencies"),
        tone: "read",
      }
    }
    case "rename_table":
      return { label: `Renamed ${str(args.table)} → ${str(args.new_name)}`, tone: "edit" }
    case "rename_column":
      return { label: `Renamed ${str(args.table)}.${str(args.column)} → ${str(args.new_name)}`, tone: "edit" }
    case "set_dependency_accepted":
      return { label: `${args.accepted === false ? "Stopped using" : "Using"} ${dep(args)}`, tone: "edit" }
    case "rebuild_design":
      return { label: "Rebuilt the design", tone: "edit" }
    case "undo_last_edit":
      return { label: "Undid the last change", tone: "edit" }
    default:
      return { label: summary || tool.replace(/_/g, " "), tone: "read" }
  }
}

// ---- where a reply goes -----------------------------------------------------------------------

/** A rework on the Design canvas shows on the canvas (plus a toast); everything else opens the thread. */
export function presentationFor(intent: Intent, context: AssistantContext): { openSidebar: boolean; toast: boolean } {
  return intent === "edit" && context === "design"
    ? { openSidebar: false, toast: true }
    : { openSidebar: true, toast: false }
}

export interface EditSummary {
  count: number
  title: string
  lines: string[]
  /** false after an undo (Undo again would walk further back, not redo) or when nothing changed */
  undoable: boolean
}

/** The toast's text: the number of changes on the canvas (from the diff when known) and what they were. */
export function editSummary(actions: AssistantAction[], changes: DesignChange[] | null): EditSummary {
  const edits = actions.filter((a) => a.ok && EDIT_TOOLS.has(a.tool))
  const lines = edits.map((a) => chipFor(a).label)
  const count = changes ? changes.length : edits.length
  if (edits.length > 0 && edits.every((a) => a.tool === "undo_last_edit"))
    return { count, title: "Undid the last change", lines: [], undoable: false }
  if (count === 0) return { count, title: "No visible changes", lines, undoable: false }
  return { count, title: `${count} ${count === 1 ? "change" : "changes"}`, lines, undoable: true }
}

// ---- errors -----------------------------------------------------------------------------------

export const RATE_LIMITED =
  "Gemini's free quota is used up for now — try again later (the daily limit resets at midnight Pacific time)."

export function friendlyError(e: unknown): FriendlyError {
  if (e instanceof ApiError) {
    if (e.code === "assistant_rate_limited")
      return { kind: "rate", title: "Rate-limited", message: RATE_LIMITED }
    if (e.code === "nothing_to_undo") return { kind: "other", title: "Nothing to undo", message: e.message }
    if (e.code === "assistant_upstream_error") {
      const detail = typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail ?? "")
      if (/\b429\b|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(detail))
        return { kind: "rate", title: "Rate-limited", message: RATE_LIMITED }
      // The server may not say why (it keeps Gemini's own error text to itself); on the free tier the
      // usual reason is the per-minute quota, so say that, as the likely cause.
      return {
        kind: "upstream",
        title: "No answer from Gemini",
        message: "Gemini didn't answer. The free tier allows only a few requests a minute, so try again in a minute.",
      }
    }
    if (e.code === "assistant_disabled")
      return {
        kind: "off",
        title: "Assistant is off",
        message: "The server has no Gemini key, so the assistant is off.",
      }
    if (e.code === "network_error") return { kind: "network", title: "Can't reach QLens", message: e.message }
    if (e.code === "conversation_not_found" || e.code === "context_mismatch")
      return { kind: "conversation", title: "Conversation gone", message: `${e.message} Start a new chat.` }
    return { kind: "other", title: "Couldn't ask", message: e.message }
  }
  return { kind: "other", title: "Couldn't ask", message: e instanceof Error ? e.message : String(e) }
}

// ---- stored conversations ---------------------------------------------------------------------

export function threadFromDetail(detail: ConversationDetail): Turn[] {
  return detail.messages.map((m) => {
    if (m.role === "user")
      return { key: `m${m.id}`, role: "user", text: m.content, chips: [], sqlRuns: [], fresh: false }
    const sqlRuns: SqlRun[] = []
    for (const c of m.tool_calls) {
      if (c.tool !== "run_sql" || !c.ok) continue
      const r = rec(c.result)
      sqlRuns.push({
        sql: str(c.args.sql),
        row_count: typeof r.row_count === "number" ? r.row_count : 0,
        columns: list(r.columns).map((name) => ({ name })),
        rows: (Array.isArray(r.rows) ? r.rows : []).slice(0, 20) as SqlRun["rows"],
      })
    }
    return {
      key: `m${m.id}`,
      role: "assistant",
      text: m.content,
      intent: m.intent ?? "answer",
      chips: m.tool_calls.map((c) => chipFor({ ...c, error: c.error })),
      sqlRuns,
      fresh: false,
    }
  })
}

// ---- example prompts --------------------------------------------------------------------------

const RENAMES: Record<string, string> = {
  students: "learners",
  teachers: "tutors",
  customers: "clients",
  products: "items",
  batches: "groups",
  employees: "staff",
  members: "residents",
}

const spoken = (name: string) => name.replace(/_/g, " ")
const GENERAL = "What does each table hold?"

/** Up to three prompts that point at real tables and columns of this design. */
export function designSuggestions(tables: TableOut[]): string[] {
  const out: string[] = []
  const entities = tables.filter((t) => t.kind === "entity")
  // "Why is teacher_phone in teachers?": an attribute that isn't the table's own natural key
  for (const t of [...entities].reverse()) {
    const key = new Set(t.unique_keys[0] ?? [])
    const attr = t.columns.find((c) => c.role === "attribute" && !key.has(c.name))
    if (attr) {
      out.push(`Why is ${attr.name} in ${t.name}?`)
      break
    }
  }
  const renamable = entities.find((t) => RENAMES[t.name])
  if (renamable) out.push(`Rename ${renamable.name} to ${RENAMES[renamable.name]}`)
  // "Does batch decide fee paid?": an entity other entities point at, and a fact attribute
  const referencedByEntity = new Set(
    entities.flatMap((t) => t.columns.filter((c) => c.role === "fk").map((c) => c.references_table_id)),
  )
  const middle = entities.find((t) => referencedByEntity.has(t.id))
  const fact = tables.find((t) => t.kind === "fact")
  if (middle && fact) {
    const lhs = middle.unique_keys[0]?.[0] ?? middle.columns.find((c) => c.role === "attribute")?.name
    const inKey = new Set(fact.unique_keys.flat())
    const rhs = fact.columns.find((c) => c.role === "attribute" && !inKey.has(c.name))
    if (lhs && rhs) out.push(`Does ${spoken(lhs)} decide ${spoken(rhs.name)}?`)
  }
  if (out.length === 0) out.push(GENERAL)
  return out.slice(0, 3)
}

/** Prompts for the Query screen; `refs` are the tables a table's foreign keys point at. */
export function querySuggestions(tables: { name: string; refs: string[] }[]): string[] {
  const out = ["How many rows does each table have?"]
  const fact = [...tables].sort((a, b) => b.refs.length - a.refs.length)[0]
  const pointsAt = tables.some((t) => t.refs.length > 0)
  if (fact && pointsAt) {
    // the table nothing points at is the fact table; prefer it over a middle entity
    const referenced = new Set(tables.flatMap((t) => t.refs))
    const leaf = tables.find((t) => t.refs.length > 0 && !referenced.has(t.name)) ?? fact
    out.push(`Show 10 rows of ${leaf.name} with names instead of ids`)
    out.push(`Which ${leaf.refs[0]} appear most often in ${leaf.name}?`)
  }
  return out
}

// ---- SQL shown and SQL run --------------------------------------------------------------------

/** SQL compared as text: whitespace runs collapsed, no trailing semicolons. */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s;]+$/, "")
}

/**
 * A reply often shows the SQL it ran in a fenced block, and the reply also lists the run. Pair them so
 * the SQL appears once, with its rows: `byBlock[i]` is the run for the i-th SQL block (or null), `rest`
 * the runs no block shows. Each run is used once.
 */
export function attachRuns(text: string, runs: SqlRun[]): { byBlock: (SqlRun | null)[]; rest: SqlRun[] } {
  const left = [...runs]
  const byBlock = parseMarkdown(text)
    .filter(isSqlBlock)
    .map((b) => {
      const i = left.findIndex((r) => normalizeSql(r.sql) === normalizeSql(b.text))
      return i === -1 ? null : left.splice(i, 1)[0]
    })
  return { byBlock, rest: left }
}

// ---- typewriter -------------------------------------------------------------------------------

/**
 * Where the typewriter pauses: after whole words, at most `maxSteps` times, always ending at the
 * full text. The replies are not streamed by the API; this only paces how the finished text appears.
 */
export function typewriterCuts(text: string, maxSteps: number): number[] {
  if (!text) return [0]
  const ends: number[] = []
  for (let i = 1; i < text.length; i++) if (/\s/.test(text[i]) && !/\s/.test(text[i - 1])) ends.push(i)
  ends.push(text.length)
  if (ends.length <= maxSteps) return ends
  const out: number[] = []
  for (let k = 1; k <= maxSteps; k++) out.push(ends[Math.round((k * ends.length) / maxSteps) - 1])
  return [...new Set(out)]
}
