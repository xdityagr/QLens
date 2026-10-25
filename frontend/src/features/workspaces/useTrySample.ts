import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router"
import { ApiError, datasetApi, workspacesApi } from "../../lib/api"
import type { SampleName, WorkspaceOut } from "../../lib/types"
import { uniqueName } from "./dashboard"
import { WS_LIST_KEY, wsKey } from "./queries"

export class SampleLoadError extends Error {
  readonly workspace: WorkspaceOut
  constructor(workspace: WorkspaceOut, message: string) {
    super(message)
    this.name = "SampleLoadError"
    this.workspace = workspace
  }
}

export interface SampleMeta {
  name: SampleName
  title: string
  blurb: string
  rows: number
  lane: number
}

// Same bundled samples as the Import screen (backend qlens/samples); counts are fixed by the generator's seed.
export const SAMPLES: SampleMeta[] = [
  { name: "fee_register", title: "Coaching fee register", blurb: "300 students, ten months of fees", rows: 3000, lane: 0 },
  { name: "kirana_sales", title: "Kirana sales", blurb: "600 bills from a corner shop", rows: 2009, lane: 3 },
  { name: "hostel_mess", title: "Hostel mess", blurb: "Three meals a day for 60 students", rows: 2520, lane: 5 },
]

/**
 * "Try a sample": create a workspace named after the sample, load the sample into it and open Analyze.
 * If loading fails after the workspace exists, stay on the dashboard and show a SampleLoadError naming it.
 */
export function useTrySample() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  return useMutation({
    mutationFn: async (sample: SampleMeta) => {
      const taken = (qc.getQueryData<WorkspaceOut[]>(WS_LIST_KEY) ?? []).map((w) => w.name)
      let name = uniqueName(sample.title, taken)
      let ws: WorkspaceOut
      try {
        ws = await workspacesApi.create(name)
      } catch (e) {
        // The cached list can be stale; one retry with the next free number.
        if (!(e instanceof ApiError && e.code === "workspace_name_taken")) throw e
        name = uniqueName(sample.title, [...taken, name])
        ws = await workspacesApi.create(name)
      }
      try {
        await datasetApi.sample(ws.id, sample.name)
      } catch (e) {
        // The workspace exists now; say so, and why the sample didn't load, instead of failing silently.
        const why = e instanceof Error ? e.message : "unknown error"
        throw new SampleLoadError(ws, `Created “${ws.name}”, but the sample didn't load: ${why}`)
      }
      return ws
    },
    onSuccess: (ws) => {
      qc.invalidateQueries({ queryKey: wsKey(ws.id), exact: true })
      qc.invalidateQueries({ queryKey: WS_LIST_KEY, exact: true })
      navigate(`/w/${ws.id}/analyze`)
    },
    onError: (e) => {
      // A half-made workspace still belongs in the list.
      if (e instanceof SampleLoadError) qc.invalidateQueries({ queryKey: WS_LIST_KEY, exact: true })
    },
  })
}
