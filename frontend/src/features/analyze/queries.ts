import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { analysisApi, ApiError } from "../../lib/api"
import type { AnalysisOut } from "../../lib/types"
import { analysisKey, datasetKey, refreshWorkspace } from "../import/queries"

/** The stored analysis, or null when the sheet hasn't been analyzed yet (404 not_analyzed). */
export function useAnalysis(wsId: number, enabled = true) {
  return useQuery({
    queryKey: analysisKey(wsId),
    enabled,
    queryFn: async () => {
      try {
        return await analysisApi.get(wsId)
      } catch (e) {
        if (e instanceof ApiError && (e.code === "not_analyzed" || e.code === "no_dataset")) return null
        throw e
      }
    },
  })
}

export function useRunAnalysis(wsId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => analysisApi.run(wsId),
    onSuccess: (a) => {
      qc.setQueryData(analysisKey(wsId), a)
      refreshWorkspace(qc, wsId)
    },
  })
}

/**
 * Every cleanup action (merge, dismiss, fix, accept all) edits the working copy of the sheet and
 * answers with a fresh analysis; the preview and column profile change with it.
 */
export function useCleanup<V>(wsId: number, fn: (v: V) => Promise<AnalysisOut>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (a) => {
      qc.setQueryData(analysisKey(wsId), a)
      qc.invalidateQueries({ queryKey: datasetKey(wsId) })
      refreshWorkspace(qc, wsId)
    },
  })
}

export function useSetAccepted(wsId: number) {
  const qc = useQueryClient()
  const key = analysisKey(wsId)
  return useMutation({
    mutationFn: ({ fdId, accepted }: { fdId: number; accepted: boolean }) =>
      analysisApi.setAccepted(wsId, fdId, accepted),
    onMutate: async ({ fdId, accepted }) => {
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<AnalysisOut | null>(key)
      if (prev) qc.setQueryData(key, { ...prev, fds: prev.fds.map((f) => (f.id === fdId ? { ...f, accepted } : f)) })
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev)
    },
    // Accepting or rejecting changes which dependencies are derived and which conflicts are listed.
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  })
}
