import { Hammer, Lock } from "lucide-react"
import { Link } from "react-router"
import { buttonClass } from "../../components/buttonClass"
import { EmptyState } from "../../components/EmptyState"
import { nextStep, stepStates, type StepKey } from "../../lib/steps"
import { useWorkspaceContext } from "./context"

/**
 * Stand-in for a workspace step whose screen is built by a later task.
 * Says plainly that it isn't built yet; never pretends to work.
 */
export function StepPlaceholder({ step }: { step: StepKey }) {
  const { workspace } = useWorkspaceContext()
  const steps = stepStates(workspace.stage)
  const s = steps.find((x) => x.key === step)!
  const next = steps.find((x) => x.key === nextStep(workspace.stage))!
  const index = steps.indexOf(s)

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-8 sm:py-12">
      <header className="mb-8">
        <p className="mb-2 text-[13px] text-muted">
          Step {index + 1} of {steps.length}
        </p>
        <h2 className="text-[30px] font-medium leading-tight tracking-[-0.035em] text-text">{s.label}</h2>
        <p className="mt-2 max-w-[60ch] text-[15px] leading-relaxed text-muted">{s.blurb}</p>
      </header>

      {s.state === "locked" ? (
        <EmptyState
          icon={<Lock size={18} strokeWidth={1.5} />}
          title={s.needs}
          lanes={[0, 1]}
          action={
            <Link to={`/w/${workspace.id}/${next.key}`} className={buttonClass("primary")}>
              Go to {next.label}
            </Link>
          }
        >
          {s.label} works on what the earlier steps produce, so it opens once they're done.
        </EmptyState>
      ) : (
        <EmptyState icon={<Hammer size={18} strokeWidth={1.5} />} title="This screen isn't built yet" lanes={[0, 1]}>
          It arrives in a later stage of the QLens build. The step rail already tracks where this workspace is.
        </EmptyState>
      )}
    </div>
  )
}
