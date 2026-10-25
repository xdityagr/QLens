import { api } from "../../lib/api"
import type { Cell, ProposalOut } from "../../lib/types"

// Mirrors backend/qlens/assistant/{routes,service}.py.

export type AssistantContext = "design" | "query"
export type Intent = "answer" | "edit"

export interface AssistantAction {
  tool: string
  args: Record<string, unknown>
  ok: boolean
  /** one line for the user, written by the tool */
  summary: string
}

export interface SqlRun {
  sql: string
  row_count: number
  /** {name, type} per column */
  columns: { name: string; type?: string }[]
  /** at most 20 rows */
  rows: Cell[][]
}

export interface AssistantReply {
  conversation_id: number
  message_id: number
  intent: Intent
  /** markdown */
  reply: string
  actions: AssistantAction[]
  /** the live design after an edit; null for answers */
  proposal: ProposalOut | null
  sql_runs: SqlRun[]
}

export interface ConversationOut {
  id: number
  context: AssistantContext
  title: string
  updated_at: string
  message_count: number
}

export interface ToolCallOut {
  seq: number
  tool: string
  args: Record<string, unknown>
  ok: boolean
  result: unknown
  error: string | null
  query_run_id: number | null
}

export interface MessageOut {
  id: number
  seq: number
  role: "user" | "assistant"
  content: string
  intent: Intent | null
  created_at: string
  tool_calls: ToolCallOut[]
}

export interface ConversationDetail {
  id: number
  context: AssistantContext
  title: string
  created_at: string
  updated_at: string
  messages: MessageOut[]
}

const base = (wsId: number) => `/api/workspaces/${wsId}/assistant`

export const assistantApi = {
  ask: (wsId: number, body: { message: string; conversation_id: number | null; context: AssistantContext }) =>
    api<AssistantReply>(base(wsId), { method: "POST", json: body }),
  conversations: (wsId: number) => api<ConversationOut[]>(`${base(wsId)}/conversations`),
  conversation: (wsId: number, id: number) => api<ConversationDetail>(`${base(wsId)}/conversations/${id}`),
}
