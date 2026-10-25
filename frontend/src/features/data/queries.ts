import { keepPreviousData, useMutation, useQuery, type QueryClient } from "@tanstack/react-query"
import { schemaKey } from "../../lib/schema"
import { dataApi, type RowsParams, type WriteValue } from "./api"

export const dataKey = (wsId: number) => ["data", wsId] as const
export const rowsKey = (wsId: number, table: string, p?: RowsParams) =>
  p ? ([...dataKey(wsId), "rows", table, p] as const) : ([...dataKey(wsId), "rows", table] as const)
export const changesKey = (wsId: number) => [...dataKey(wsId), "changes"] as const

export function useRows(wsId: number, table: string | null, p: RowsParams) {
  return useQuery({
    queryKey: rowsKey(wsId, table ?? "", p),
    enabled: table !== null,
    queryFn: () => dataApi.rows(wsId, table!, p),
    // paging, sorting and searching keep the old page on screen until the new one arrives
    placeholderData: keepPreviousData,
  })
}

export function useFkOptions(wsId: number, table: string, column: string, q: string, enabled: boolean) {
  return useQuery({
    queryKey: [...dataKey(wsId), "options", table, column, q],
    enabled,
    queryFn: () => dataApi.options(wsId, table, column, q),
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  })
}

export function useRelated(wsId: number, table: string, id: number | null) {
  return useQuery({
    queryKey: [...dataKey(wsId), "related", table, id],
    enabled: id !== null,
    queryFn: () => dataApi.related(wsId, table, id!),
  })
}

/** Recent audit rows plus how much has been edited since the last apply (Design warns before re-applying). */
export function useDataChanges(wsId: number, enabled = true) {
  return useQuery({ queryKey: changesKey(wsId), enabled, queryFn: () => dataApi.changes(wsId) })
}

/** After any write: the table's pages, the audit log and the row counts in the table list are stale. */
export function invalidateData(qc: QueryClient, wsId: number) {
  qc.invalidateQueries({ queryKey: dataKey(wsId) })
  qc.invalidateQueries({ queryKey: schemaKey(wsId) })
}

type Write =
  | { op: "insert"; table: string; values: Record<string, WriteValue> }
  | { op: "update"; table: string; id: number; values: Record<string, WriteValue> }
  | { op: "delete"; table: string; id: number }

export function useWriteRow(wsId: number) {
  return useMutation({
    mutationFn: (w: Write) =>
      w.op === "insert"
        ? dataApi.insert(wsId, w.table, w.values)
        : w.op === "update"
          ? dataApi.update(wsId, w.table, w.id, w.values)
          : dataApi.remove(wsId, w.table, w.id).then(() => null),
  })
}
