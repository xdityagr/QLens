import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ApiError, designApi } from "../../lib/api"
import { schemaKey } from "../../lib/schema"
import type { ApplyOut, ProposalOut } from "../../lib/types"
import { refreshWorkspace } from "../import/queries"
import type { RenameTarget } from "./erContext"

export const proposalKey = (wsId: number) => ["proposal", wsId] as const
export const proposalSqlKey = (wsId: number) => ["proposal", wsId, "sql"] as const

/**
 * The design to show: the draft if there is one, else the applied design. When neither exists yet
 * (first visit after Analyze) one is built on the spot. null when the workspace has no sheet.
 */
export function useProposal(wsId: number, enabled = true) {
  return useQuery({
    queryKey: proposalKey(wsId),
    enabled,
    queryFn: async (): Promise<ProposalOut | null> => {
      try {
        return await designApi.get(wsId)
      } catch (e) {
        if (!(e instanceof ApiError)) throw e
        if (e.code === "no_dataset") return null
        if (e.code === "no_proposal") return designApi.build(wsId)
        throw e
      }
    },
  })
}

/** Build a fresh draft (rebuild, or "Edit as new draft" after an apply). */
export function useBuildProposal(wsId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => designApi.build(wsId),
    onSuccess: (p) => {
      qc.setQueryData(proposalKey(wsId), p)
      qc.invalidateQueries({ queryKey: proposalSqlKey(wsId) })
    },
  })
}

export function useRename(wsId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ target, name }: { target: RenameTarget; name: string }) =>
      target.kind === "table"
        ? designApi.renameTable(wsId, target.id, name)
        : designApi.renameColumn(wsId, target.id, name),
    onSuccess: (p) => {
      qc.setQueryData(proposalKey(wsId), p)
      qc.invalidateQueries({ queryKey: proposalSqlKey(wsId) })
    },
    onError: (e) => {
      // someone applied or rebuilt in another tab; show what is really there
      if (e instanceof ApiError && e.code === "proposal_not_draft")
        qc.invalidateQueries({ queryKey: proposalKey(wsId) })
    },
  })
}

export function useProposalSql(wsId: number, enabled: boolean) {
  return useQuery({ queryKey: proposalSqlKey(wsId), enabled, queryFn: () => designApi.sql(wsId) })
}

export function useApply(wsId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (proposalId: number) => designApi.apply(wsId, proposalId),
    onSuccess: (r: ApplyOut, proposalId) => {
      const p = qc.getQueryData<ProposalOut | null>(proposalKey(wsId))
      if (p && p.id === proposalId) qc.setQueryData(proposalKey(wsId), { ...p, status: "applied", lossless_ok: true })
      qc.setQueryData(proposalSqlKey(wsId), { sql: r.sql })
      qc.invalidateQueries({ queryKey: schemaKey(wsId) })
      // the rail unlocks Query and Performance once the workspace is applied
      refreshWorkspace(qc, wsId)
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "proposal_not_draft")
        qc.invalidateQueries({ queryKey: proposalKey(wsId) })
    },
  })
}

// Shared with the Query screen; re-exported so Design's imports stay as they were.
export { useAppliedSchema } from "../../lib/schema"
export { useAssistantEnabled } from "../../lib/config"
