import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { ApiError, datasetApi } from "../../lib/api"
import type { SampleName } from "../../lib/types"
import { WS_LIST_KEY, wsKey } from "../workspaces/queries"

export const datasetKey = (wsId: number) => ["dataset", wsId] as const
export const analysisKey = (wsId: number) => ["analysis", wsId] as const

/** The dataset, or null when the workspace has none yet (404 no_dataset). */
export function useDataset(wsId: number, enabled = true) {
  return useQuery({
    queryKey: datasetKey(wsId),
    enabled,
    queryFn: async () => {
      try {
        return await datasetApi.get(wsId)
      } catch (e) {
        if (e instanceof ApiError && e.code === "no_dataset") return null
        throw e
      }
    },
  })
}

/** Stage, row counts and the step rail come from the workspace record, so refresh it after any change. */
export function refreshWorkspace(qc: QueryClient, wsId: number) {
  qc.invalidateQueries({ queryKey: wsKey(wsId), exact: true })
  qc.invalidateQueries({ queryKey: WS_LIST_KEY, exact: true })
}

export type ImportSource = { kind: "file"; file: File } | { kind: "sample"; name: SampleName }

export function useImportDataset(wsId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (src: ImportSource) =>
      src.kind === "file" ? datasetApi.upload(wsId, src.file) : datasetApi.sample(wsId, src.name),
    onSuccess: () => {
      // A new sheet replaces the old one and everything derived from it.
      qc.removeQueries({ queryKey: analysisKey(wsId) })
      qc.invalidateQueries({ queryKey: datasetKey(wsId) })
      refreshWorkspace(qc, wsId)
    },
  })
}
