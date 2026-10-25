import { NavLink } from "react-router"
import { stepStates, type StepState } from "../lib/steps"
import type { WorkspaceStage } from "../lib/types"

const STATE_TITLE: Record<StepState, string> = {
  done: "Done",
  current: "Next step",
  open: "Available",
  locked: "Locked",
}

function Node({ state }: { state: StepState }) {
  // done = filled, current = ring, open = small ring, locked = hollow muted
  if (state === "done") return <span className="block size-[9px] rounded-full bg-accent" />
  if (state === "current")
    return (
      <span className="relative grid size-[15px] place-items-center rounded-full border-2 border-accent bg-bg shadow-[0_0_0_4px_color-mix(in_oklab,var(--accent)_16%,transparent)]">
        <span className="size-[5px] rounded-full bg-accent" />
      </span>
    )
  if (state === "open") return <span className="block size-[11px] rounded-full border-2 border-accent bg-bg" />
  return <span className="block size-[11px] rounded-full border-[1.5px] border-faint bg-bg" />
}

/**
 * GitLens-graph style rail: one lane line with a node per step. The line is lit
 * through finished steps and turns into a muted dashed track where work remains.
 */
export function StepRail({
  workspaceId,
  stage,
  orientation = "vertical",
}: {
  workspaceId: number
  stage: WorkspaceStage
  orientation?: "vertical" | "horizontal"
}) {
  const steps = stepStates(stage)
  const lit = (i: number) => steps[i].state !== "locked" && steps[i + 1]?.state !== "locked"

  if (orientation === "horizontal") {
    return (
      <nav aria-label="Workspace steps" className="scrollbar-thin overflow-x-auto">
        <ol className="flex min-w-max items-center gap-1 px-4 py-2">
          {steps.map((s, i) => (
            <li key={s.key} className="flex items-center gap-1">
              <NavLink
                to={`/w/${workspaceId}/${s.key}`}
                title={STATE_TITLE[s.state]}
                className={({ isActive }) =>
                  "flex h-8 items-center gap-2 rounded-control px-2.5 text-[13px] transition-colors " +
                  (isActive ? "bg-hover text-text" : s.state === "locked" ? "text-faint" : "text-muted hover:text-text")
                }
              >
                <span className="grid w-[15px] place-items-center">
                  <Node state={s.state} />
                </span>
                {s.label}
              </NavLink>
              {i < steps.length - 1 && (
                <span
                  aria-hidden
                  className="h-px w-3"
                  style={{ background: lit(i) ? "var(--accent)" : "var(--border-strong)" }}
                />
              )}
            </li>
          ))}
        </ol>
      </nav>
    )
  }

  return (
    <nav aria-label="Workspace steps">
      <ol className="relative flex flex-col">
        {steps.map((s, i) => (
          <li key={s.key} className="relative">
            <NavLink
              to={`/w/${workspaceId}/${s.key}`}
              title={STATE_TITLE[s.state]}
              aria-description={STATE_TITLE[s.state]}
              className={({ isActive }) =>
                "relative flex h-12 items-center gap-3 rounded-control pl-3 pr-3 text-[14px] transition-colors duration-150 " +
                (isActive
                  ? "bg-hover font-medium text-text"
                  : s.state === "locked"
                    ? "text-faint hover:text-muted"
                    : "text-muted hover:bg-[color-mix(in_oklab,var(--hover)_60%,transparent)] hover:text-text")
              }
            >
              <span className="relative z-10 grid w-[15px] place-items-center">
                <Node state={s.state} />
              </span>
              <span className="truncate">{s.label}</span>
            </NavLink>
            {/* Drawn after the link so the active row's background never covers the lane. */}
            {i < steps.length - 1 && (
              <span
                aria-hidden
                className="pointer-events-none absolute left-[19.5px] top-[24px] z-[5] h-[48px] w-0 -translate-x-1/2"
                style={
                  lit(i)
                    ? { borderLeft: "2px solid var(--accent)" }
                    : { borderLeft: "2px dashed var(--border-strong)" }
                }
              />
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}
