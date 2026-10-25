import { useOutletContext } from "react-router"
import type { WorkspaceOut } from "../../lib/types"

/** What WorkspaceLayout hands to every step page through <Outlet context>. */
export interface WorkspaceContext {
  workspace: WorkspaceOut
}

export function useWorkspaceContext() {
  return useOutletContext<WorkspaceContext>()
}
