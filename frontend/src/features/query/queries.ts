import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo } from "react"
import type { DatasetOut } from "../../lib/types"
import { refreshWorkspace, useDataset } from "../import/queries"
import { queryApi, type QueryableTable } from "./api"

export const savedKey = (wsId: number) => ["saved-queries", wsId] as const
export const trendKey = (wsId: number, sqId: number) => ["saved-queries", wsId, sqId, "trend"] as const
export const historyKey = (wsId: number) => ["history", wsId] as const
export const slowKey = (wsId: number) => ["slow-queries", wsId] as const

/**
 * The sheet's own tables in the src schema (on the sandbox's search_path). /schema only describes
 * the main and lab schemas, so these are read off the dataset's column list: _raw keeps every value
 * as text, _staging holds the typed (and cleaned) copy.
 */
export function useSourceTables(wsId: number, enabled: boolean): QueryableTable[] {
  const { data } = useDataset(wsId, enabled)
  return useMemo(() => (enabled && data ? sourceTablesOf(data) : []), [enabled, data])
}

const SRC_TYPE: Record<string, string> = {
  integer: "bigint",
  numeric: "numeric",
  boolean: "boolean",
  date: "date",
  text: "text",
}

function sourceTablesOf(data: DatasetOut): QueryableTable[] {
  const rowId = { name: "_row_id", data_type: "bigint", is_pk: true }
  return [
    {
      name: "_staging",
      color_index: null,
      row_count: data.row_count,
      columns: [rowId, ...data.columns.map((c) => ({ name: c.name, data_type: SRC_TYPE[c.inferred_type] ?? "text" }))],
    },
    {
      name: "_raw",
      color_index: null,
      row_count: data.row_count,
      columns: [rowId, ...data.columns.map((c) => ({ name: c.name, data_type: "text" }))],
    },
  ]
}

export function useSavedQueries(wsId: number, enabled = true) {
  return useQuery({ queryKey: savedKey(wsId), enabled, queryFn: () => queryApi.savedList(wsId) })
}

export function useTrend(wsId: number, sqId: number, runCount: number) {
  return useQuery({
    // run_count in the key: a new run of this query refetches its trend and nothing else's
    queryKey: [...trendKey(wsId, sqId), runCount],
    enabled: runCount > 0,
    queryFn: () => queryApi.trend(wsId, sqId),
    placeholderData: (prev) => prev,
  })
}

export function useHistory(wsId: number, enabled = true) {
  return useQuery({ queryKey: historyKey(wsId), enabled, queryFn: () => queryApi.history(wsId, 100) })
}

export function useSlowQueries(wsId: number, enabled = true) {
  return useQuery({ queryKey: slowKey(wsId), enabled, queryFn: () => queryApi.slow(wsId) })
}

/** Every run (ok or not) adds a history row; ok runs of a saved query also bump its stats. */
export function useRunQuery(wsId: number) {
  const qc = useQueryClient()
  const after = () => {
    qc.invalidateQueries({ queryKey: historyKey(wsId) })
    qc.invalidateQueries({ queryKey: slowKey(wsId) })
    qc.invalidateQueries({ queryKey: savedKey(wsId), exact: true })
    refreshWorkspace(qc, wsId)
  }
  return useMutation({
    mutationFn: ({ sql, savedQueryId }: { sql: string; savedQueryId?: number | null }) =>
      queryApi.run(wsId, sql, savedQueryId),
    onSettled: after,
  })
}

export function useSaveQuery(wsId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { id?: number; title: string; sql_text: string }) =>
      v.id
        ? queryApi.update(wsId, v.id, { title: v.title, sql_text: v.sql_text })
        : queryApi.save(wsId, v.title, v.sql_text),
    onSuccess: () => qc.invalidateQueries({ queryKey: savedKey(wsId), exact: true }),
  })
}

export function useDeleteSavedQuery(wsId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (sqId: number) => queryApi.remove(wsId, sqId),
    onSuccess: () => qc.invalidateQueries({ queryKey: savedKey(wsId), exact: true }),
  })
}
