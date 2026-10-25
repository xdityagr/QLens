import type { HTMLAttributes } from "react"

export function Card({ className = "", ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`rounded-card border border-border bg-surface ${className}`} {...rest} />
}
