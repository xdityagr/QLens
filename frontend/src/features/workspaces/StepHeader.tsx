import type { ReactNode } from "react"
import { STEPS, type StepKey } from "../../lib/steps"

/** Title block shared by the workspace step pages: "Step n of 6", name, one-line blurb, actions. */
export function StepHeader({ step, actions, children }: { step: StepKey; actions?: ReactNode; children?: ReactNode }) {
  const index = STEPS.findIndex((s) => s.key === step)
  const s = STEPS[index]
  return (
    <header className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <p className="mb-2 text-[13px] text-muted">
          Step {index + 1} of {STEPS.length}
        </p>
        <h2 className="text-[30px] font-medium leading-tight tracking-[-0.035em] text-text">{s.label}</h2>
        <p className="mt-2 max-w-[62ch] text-[15px] leading-relaxed text-muted">{children ?? s.blurb}</p>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-start gap-2 sm:flex-col sm:items-end">{actions}</div>}
    </header>
  )
}
