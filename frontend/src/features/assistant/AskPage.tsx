import { useQueryClient } from "@tanstack/react-query"
import { Lock, MessageSquareText } from "lucide-react"
import { lazy, Suspense } from "react"
import { Link } from "react-router"
import { buttonClass } from "../../components/buttonClass"
import { EmptyState } from "../../components/EmptyState"
import { Spinner } from "../../components/Spinner"
import { configKey, useAppConfig } from "../../lib/config"
import { useAppliedSchema } from "../../lib/schema"
import { useWorkspaceContext } from "../workspaces/context"
import { StepHeader } from "../workspaces/StepHeader"

// The chat (markdown, the thread, the result grids) loads the first time the step opens.
const AskChat = lazy(() => import("./AskChat"))

const Centered = () => (
  <div className="grid h-[calc(100dvh-var(--app-header-h)-var(--step-strip-h))] place-items-center text-muted">
    <Spinner size={20} />
  </div>
)

/** The Ask AI step: plain-English questions about the applied tables, on a page of their own. */
export function AskPage() {
  const { workspace } = useWorkspaceContext()
  const config = useAppConfig()
  // useAppConfig reads "off" until the answer arrives; wait for it rather than flash "Ask AI is off"
  const configReady = useQueryClient().getQueryState(configKey)?.status !== "pending"
  const applied = workspace.stage === "applied"
  const schema = useAppliedSchema(workspace.id, applied)

  if (!applied || !config.assistant_enabled) {
    const off = applied && configReady
    if (applied && !configReady) return <Centered />
    return (
      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-8 sm:py-12">
        <StepHeader step="ask" />
        {off ? (
          <EmptyState icon={<MessageSquareText size={18} strokeWidth={1.5} />} title="Ask AI is off" lanes={[3, 1]}>
            The server has no Gemini API key, so plain-English questions are turned off. Browse and SQL on the Data
            step work without it.
          </EmptyState>
        ) : (
          <EmptyState
            icon={<Lock size={18} strokeWidth={1.5} />}
            title="Apply a design first"
            lanes={[4, 0]}
            action={
              <Link to={`/w/${workspace.id}/design`} className={buttonClass("primary")}>
                Go to Design
              </Link>
            }
          >
            The assistant answers questions about the tables Design creates, so there is nothing to ask until a
            design is applied.
          </EmptyState>
        )}
      </div>
    )
  }
  if (schema.isPending) return <Centered />
  if (schema.error)
    return (
      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-8 sm:py-12">
        <StepHeader step="ask" />
        <EmptyState title="Couldn't load the tables" lanes={[7, 3]}>
          {schema.error.message}
        </EmptyState>
      </div>
    )
  return (
    <Suspense fallback={<Centered />}>
      {/* a new workspace starts a fresh chat */}
      <AskChat key={workspace.id} wsId={workspace.id} tables={schema.data.tables} />
    </Suspense>
  )
}
