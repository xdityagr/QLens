import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useRef, useState } from "react"
import type { DesignChange } from "../../lib/proposalDiff"
import type { ProposalOut } from "../../lib/types"
import { assistantApi, type AssistantContext, type AssistantReply } from "./api"
import {
  chipFor,
  editSummary,
  friendlyError,
  presentationFor,
  threadFromDetail,
  type EditSummary,
  type FriendlyError,
  type Turn,
} from "./logic"

export const conversationsKey = (wsId: number) => ["assistant", wsId, "conversations"] as const
const conversationKey = (wsId: number, id: number) => ["assistant", wsId, "conversation", id] as const

export interface EditToast {
  key: number
  summary: EditSummary
}

export interface AssistantOptions {
  wsId: number
  context: AssistantContext
  /**
   * Apply what a reply brings (a new design, new query runs). Returns the design changes it made, for
   * the toast's count, or null when they can't be told.
   */
  onReply?: (reply: AssistantReply) => DesignChange[] | null | void
  /** Apply the design an Undo went back to; returns its changes, as onReply does. */
  onUndo?: (proposal: ProposalOut) => DesignChange[] | null | void
}

/** Run a screen's side effect without letting its bug lose the reply that is already back. */
function guarded<T>(fn: (() => T) | undefined): T | null {
  try {
    return fn?.() ?? null
  } catch (err) {
    console.error("assistant: applying the reply failed", err)
    return null
  }
}

/**
 * One assistant thread on one screen. The API answers in one piece (no streaming), so a message is
 * pending until the whole reply is back; the reply then either opens the sidebar or, for a design edit,
 * shows a toast while the canvas animates.
 */
export function useAssistant({ wsId, context, onReply, onUndo }: AssistantOptions) {
  const qc = useQueryClient()
  const [conversationId, setConversationId] = useState<number | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [pending, setPending] = useState<string | null>(null)
  // `message` is what Try again resends; `undo` marks a failed Undo, which Try again repeats instead
  const [error, setError] = useState<{ error: FriendlyError; message: string; undo?: boolean } | null>(null)
  const [undoing, setUndoing] = useState(false)
  const [open, setOpen] = useState(false)
  const [toast, setToast] = useState<EditToast | null>(null)
  const [draft, setDraft] = useState("")
  const [loading, setLoading] = useState(false)
  // the async ask reads these after awaits, so they live in refs as well
  const convId = useRef<number | null>(null)
  const busy = useRef(false)
  const onReplyRef = useRef(onReply)
  const onUndoRef = useRef(onUndo)
  useEffect(() => {
    onReplyRef.current = onReply
    onUndoRef.current = onUndo
  })

  const ask = useCallback(
    async (text: string) => {
      const message = text.trim()
      if (!message || busy.current) return
      busy.current = true
      setPending(message)
      setError(null)
      setTurns((t) => [
        ...t.filter((x) => !x.error),
        { key: `u${Date.now()}`, role: "user", text: message, chips: [], sqlRuns: [], fresh: false },
      ])
      try {
        const reply = await assistantApi.ask(wsId, { message, conversation_id: convId.current, context })
        convId.current = reply.conversation_id
        setConversationId(reply.conversation_id)
        const changes = guarded(() => onReplyRef.current?.(reply) ?? null)
        setTurns((t) => [
          ...t,
          {
            key: `m${reply.message_id}`,
            role: "assistant",
            text: reply.reply,
            intent: reply.intent,
            chips: reply.actions.map(chipFor),
            sqlRuns: reply.sql_runs,
            fresh: true,
          },
        ])
        const how = presentationFor(reply.intent, context)
        if (how.toast) setToast({ key: reply.message_id, summary: editSummary(reply.actions, changes) })
        if (how.openSidebar) setOpen(true)
        void qc.invalidateQueries({ queryKey: conversationsKey(wsId) })
      } catch (e) {
        const fe = friendlyError(e)
        if (fe.kind === "conversation") {
          convId.current = null
          setConversationId(null)
        }
        setError({ error: fe, message })
        setTurns((t) => [
          ...t,
          { key: `e${Date.now()}`, role: "assistant", text: "", chips: [], sqlRuns: [], fresh: false, error: fe },
        ])
      } finally {
        busy.current = false
        setPending(null)
      }
    },
    [wsId, context, qc],
  )

  /**
   * The toast's Undo: the server's undo endpoint runs the assistant's undo tool directly, so it costs no
   * model call and always goes back exactly one design version.
   */
  const undo = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    setUndoing(true)
    setError(null)
    try {
      const r = await assistantApi.undo(wsId)
      const changes = guarded(() => onUndoRef.current?.(r.proposal) ?? null)
      const undone = { tool: "undo_last_edit", args: {}, ok: true, summary: "Undid the last design change" }
      setToast({ key: Date.now(), summary: editSummary([undone], changes) })
    } catch (e) {
      setToast(null)
      setError({ error: friendlyError(e), message: "", undo: true })
    } finally {
      busy.current = false
      setUndoing(false)
    }
  }, [wsId])

  /** Send the failed message again (it stays in the thread once), or repeat a failed Undo. */
  const retry = useCallback(() => {
    if (!error) return
    if (error.undo) {
      void undo()
      return
    }
    const message = error.message
    setTurns((t) => {
      const lastUser = t.map((x) => x.role).lastIndexOf("user")
      return lastUser >= 0 && t[lastUser].text === message ? t.slice(0, lastUser) : t
    })
    void ask(message)
  }, [error, ask, undo])

  const newChat = useCallback(() => {
    if (busy.current) return
    convId.current = null
    setConversationId(null)
    setTurns([])
    setError(null)
    setToast(null)
  }, [])

  const openConversation = useCallback(
    async (id: number) => {
      if (busy.current) return
      setLoading(true)
      setError(null)
      try {
        const detail = await qc.fetchQuery({
          queryKey: conversationKey(wsId, id),
          queryFn: () => assistantApi.conversation(wsId, id),
          staleTime: 0,
        })
        convId.current = detail.id
        setConversationId(detail.id)
        setTurns(threadFromDetail(detail))
        setToast(null)
      } catch (e) {
        const fe = friendlyError(e)
        setTurns([
          { key: `e${Date.now()}`, role: "assistant", text: "", chips: [], sqlRuns: [], fresh: false, error: fe },
        ])
      } finally {
        setLoading(false)
      }
    },
    [qc, wsId],
  )

  /** The typewriter finished: show the turn as plain text from now on. */
  const settle = useCallback((key: string) => {
    setTurns((t) => t.map((x) => (x.key === key && x.fresh ? { ...x, fresh: false } : x)))
  }, [])

  return {
    context,
    conversationId,
    turns,
    pending,
    error,
    clearError: () => setError(null),
    open,
    setOpen,
    toast,
    undoing,
    dismissToast: () => setToast(null),
    draft,
    setDraft,
    loading,
    ask,
    retry,
    undo,
    newChat,
    openConversation,
    settle,
  }
}

export type Assistant = ReturnType<typeof useAssistant>

/** This screen's earlier conversations, newest first (fetched when the history menu opens). */
export function useConversations(wsId: number, context: AssistantContext, enabled: boolean) {
  return useQuery({
    queryKey: conversationsKey(wsId),
    enabled,
    queryFn: () => assistantApi.conversations(wsId),
    select: (all) => all.filter((c) => c.context === context),
  })
}
