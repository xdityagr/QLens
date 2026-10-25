import type { WorkspaceStage } from "./types"

export type StepKey = "import" | "analyze" | "design" | "data" | "ask" | "history"
// done = finished, current = the next thing to do, open = usable but not the focus,
// locked = needs an earlier step first.
export type StepState = "done" | "current" | "open" | "locked"

export interface StepDef {
  key: StepKey
  label: string
  blurb: string
  // What must happen before this step unlocks; shown on locked placeholders.
  needs: string
}

export const STEPS: StepDef[] = [
  { key: "import", label: "Import", blurb: "Upload a CSV or Excel sheet, preview it and check the inferred column types.", needs: "" },
  { key: "analyze", label: "Analyze", blurb: "Find which columns determine which, candidate keys and messy values.", needs: "Import a sheet first." },
  { key: "design", label: "Design", blurb: "Split the sheet into 3NF tables, rename them, and apply with a lossless check.", needs: "Run the analysis first." },
  { key: "data", label: "Data", blurb: "Use your new database: browse and edit rows, and run SQL with plans and a step-through.", needs: "Apply a design first." },
  { key: "ask", label: "Ask AI", blurb: "Ask about the rows in plain English; the assistant writes a SELECT, runs it read-only and shows the rows and the SQL.", needs: "Apply a design first." },
  { key: "history", label: "History", blurb: "Every query you ran, the ones you saved, and which ones were slow.", needs: "Apply a design first." },
]

const PROGRESS: Record<WorkspaceStage, number> = { empty: 0, imported: 1, analyzed: 2, applied: 3 }

export function stepStates(stage: WorkspaceStage): (StepDef & { state: StepState })[] {
  const reached = PROGRESS[stage]
  return STEPS.map((step, i) => {
    let state: StepState
    if (i < 3) state = i < reached ? "done" : i === reached ? "current" : "locked"
    else if (reached < 3) state = "locked"
    // after the apply, using the data is the next thing to do; Ask AI and History are open alongside it
    else state = step.key === "data" ? "current" : "open"
    return { ...step, state }
  })
}

// Where "Open" on a dashboard card should land.
export function nextStep(stage: WorkspaceStage): StepKey {
  return stepStates(stage).find((s) => s.state === "current")!.key
}

export const STAGE_META: Record<WorkspaceStage, { label: string; lane: number | null }> = {
  empty: { label: "No data yet", lane: null },
  imported: { label: "Imported", lane: 0 },
  analyzed: { label: "Analyzed", lane: 1 },
  applied: { label: "Applied", lane: 4 },
}
