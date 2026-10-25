import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { workspacesApi } from "../../lib/api"

export const WS_LIST_KEY = ["workspaces"] as const
export const wsKey = (id: number) => ["workspaces", id] as const

export function useWorkspaces() {
  return useQuery({ queryKey: WS_LIST_KEY, queryFn: workspacesApi.list })
}

export function useWorkspace(id: number) {
  return useQuery({
    queryKey: wsKey(id),
    queryFn: () => workspacesApi.get(id),
    enabled: Number.isInteger(id) && id > 0,
    retry: (n, e) => n < 2 && !("status" in e && (e as { status: number }).status === 404),
  })
}

export function useCreateWorkspace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => workspacesApi.create(name),
    onSuccess: (ws) => {
      qc.setQueryData(wsKey(ws.id), ws)
      qc.invalidateQueries({ queryKey: WS_LIST_KEY, exact: true })
    },
  })
}

export function useDeleteWorkspace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => workspacesApi.remove(id),
    onSuccess: (_v, id) => {
      qc.removeQueries({ queryKey: wsKey(id) })
      qc.invalidateQueries({ queryKey: WS_LIST_KEY, exact: true })
    },
  })
}
