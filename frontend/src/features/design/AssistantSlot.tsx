import type { ReactNode } from "react"

/**
 * Where the assistant's floating command bar goes: bottom-centre of the canvas, clear of the zoom
 * controls (bottom-left). DesignPage renders it, with the assistant's bar as children, only when
 * GET /api/config says the assistant is on.
 */
export function AssistantSlot({ children }: { children?: ReactNode }) {
  if (!children) return null
  return (
    <div
      data-slot="assistant"
      className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-4 [&>*]:pointer-events-auto"
    >
      {children}
    </div>
  )
}
