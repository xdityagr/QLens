import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { chooseScaleFactor } from "../../lib/plan"
import { historyKey, slowKey } from "../query/queries"
import { perfApi, type ExperimentOut, type IndexSuggestion, type LabOut } from "./api"

export const explainKey = (wsId: number, sql: string) => ["explain", wsId, sql] as const

/**
 * EXPLAIN ANALYZE of `sql` on the real tables. A query (not a mutation) so the same SQL is explained once,
 * however often the panel re-renders or remounts; refetch() explains it again.
 */
export function useExplain(wsId: number, sql: string) {
  const qc = useQueryClient()
  return useQuery({
    queryKey: explainKey(wsId, sql),
    enabled: sql.trim() !== "",
    retry: false,
    staleTime: Infinity,
    queryFn: async () => {
      try {
        return await perfApi.explain(wsId, sql, "main")
      } finally {
        // every explain is a run in History (source "Performance"), failed ones too
        void qc.invalidateQueries({ queryKey: historyKey(wsId) })
        void qc.invalidateQueries({ queryKey: slowKey(wsId) })
      }
    },
  })
}

export type SpeedTestPhase = "copy" | "grow" | "time"

export interface SpeedTestResult {
  experiment: ExperimentOut
  /** the lab as the timing saw it */
  lab: LabOut
}

/**
 * "Test the speed-up": everything happens in the lab, a scratch copy of the applied tables, so the real
 * tables are never touched. Make sure the copy exists, grow it once (so an index has something to beat),
 * clear an earlier test of the same index, then time the query before and after creating the index.
 */
export function useSpeedTest(wsId: number) {
  const [phase, setPhase] = useState<SpeedTestPhase | null>(null)
  const [growBy, setGrowBy] = useState<number | null>(null)
  const m = useMutation({
    mutationFn: async ({ sql, suggestion }: { sql: string; suggestion: IndexSuggestion }): Promise<SpeedTestResult> => {
      setPhase("copy")
      let lab = await perfApi.build(wsId)
      if (lab.scale_factor === 1) {
        const factor = chooseScaleFactor(Math.max(0, ...lab.tables.map((t) => t.row_count)))
        if (factor) {
          setGrowBy(factor)
          setPhase("grow")
          lab = await perfApi.scale(wsId, factor)
        }
      }
      setPhase("time")
      const same = (await perfApi.experiments(wsId)).filter(
        (e) =>
          e.status === "kept" &&
          e.table === suggestion.table &&
          e.columns.join("\u0000") === suggestion.columns.join("\u0000"),
      )
      for (const e of same) await perfApi.drop(wsId, e.id)
      const experiment = await perfApi.tryIndex(wsId, sql, suggestion.table, suggestion.columns)
      return { experiment, lab: await perfApi.lab(wsId) }
    },
    onSettled: () => setPhase(null),
  })
  return { ...m, phase, growBy }
}

/** Rebuild the test copy from the real tables at their real size, without the indexes tried on it. */
export function useResetLab(wsId: number) {
  return useMutation({ mutationFn: () => perfApi.reset(wsId) })
}
