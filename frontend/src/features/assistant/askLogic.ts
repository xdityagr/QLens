// The Ask AI page's pure parts: which questions the empty page offers, and how the conversation list is grouped.

import { starterQuestions, type SnippetTable } from "../../lib/snippets"
import type { ConversationOut } from "./api"
import { querySuggestions } from "./logic"

/**
 * Up to `max` questions to start from, read off the applied schema: the schema-shaped starters first (the fact
 * table's number, its period, the table beyond), topped up with the generic query prompts when the schema is
 * too flat to give four. Duplicates (ignoring case) are dropped.
 */
export function askStarters(tables: SnippetTable[], max = 6): string[] {
  const refs = tables.map((t) => ({
    name: t.name,
    refs: t.columns.flatMap((c) => (c.fk && c.fk.table !== t.name ? [c.fk.table] : [])),
  }))
  const out: string[] = []
  const seen = new Set<string>()
  for (const q of [...starterQuestions(tables), ...(tables.length ? querySuggestions(refs) : [])]) {
    const k = q.trim().toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(q)
  }
  return out.slice(0, max)
}

export interface ConversationGroup {
  label: string
  items: ConversationOut[]
}

const DAY = 86_400_000
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** Newest first, bucketed by local day: Today, Yesterday, Previous 7 days, Older. Empty buckets are left out. */
export function groupConversations(list: ConversationOut[], now: Date = new Date()): ConversationGroup[] {
  const today = startOfDay(now)
  const buckets: ConversationGroup[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "Previous 7 days", items: [] },
    { label: "Older", items: [] },
  ]
  const sorted = [...list].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
  for (const c of sorted) {
    const t = Date.parse(c.updated_at)
    const i = t >= today ? 0 : t >= today - DAY ? 1 : t >= today - 7 * DAY ? 2 : 3
    buckets[i].items.push(c)
  }
  return buckets.filter((b) => b.items.length > 0)
}

/** The conversation's name in the header: the stored title, else the first question asked, else "New chat". */
export function chatTitle(stored: string | null | undefined, firstQuestion: string | undefined): string {
  return stored?.trim() || firstQuestion?.trim() || "New chat"
}
