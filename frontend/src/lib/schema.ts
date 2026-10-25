import { useQuery } from "@tanstack/react-query"
import { designApi } from "./api"

/** The applied tables as the catalog describes them (GET /schema?kind=main); Design and Query share this cache. */
export const schemaKey = (wsId: number) => ["schema", wsId, "main"] as const

export function useAppliedSchema(wsId: number, enabled = true) {
  return useQuery({ queryKey: schemaKey(wsId), enabled, queryFn: () => designApi.schema(wsId, "main") })
}
