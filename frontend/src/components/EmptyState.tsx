import type { ReactNode } from "react"
import { NoiseBackdrop } from "./NoiseBackdrop"

export function EmptyState({
  icon,
  title,
  children,
  action,
  lanes = [0, 1],
  className = "",
}: {
  icon?: ReactNode
  title: string
  children?: ReactNode
  action?: ReactNode
  lanes?: [number, number]
  className?: string
}) {
  return (
    <div
      className={`relative isolate overflow-hidden rounded-card border border-border bg-surface px-6 py-14 ${className}`}
    >
      <NoiseBackdrop lanes={lanes} intensity={0.12} placement="center" animated />
      <div className="relative mx-auto flex max-w-md flex-col items-center text-center">
        {icon && (
          <div className="mb-5 grid size-11 place-items-center rounded-full border border-border-strong bg-raised text-muted">
            {icon}
          </div>
        )}
        <h2 className="text-[19px] font-medium tracking-[-0.015em] text-text">{title}</h2>
        {children && <div className="mt-2 text-[14px] leading-relaxed text-muted">{children}</div>}
        {action && <div className="mt-6">{action}</div>}
      </div>
    </div>
  )
}
