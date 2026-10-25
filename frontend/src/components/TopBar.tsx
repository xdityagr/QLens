import type { ReactNode } from "react"
import { ThemeToggle } from "./ThemeToggle"
import { UserMenu } from "./UserMenu"
import { Wordmark } from "./Wordmark"

export function TopBar({ children }: { children?: ReactNode }) {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-[color-mix(in_oklab,var(--bg)_82%,transparent)] backdrop-blur-md">
      <div className="flex h-14 items-center gap-3 px-4 sm:px-5">
        <Wordmark />
        {children}
        <div className="ml-auto flex items-center gap-1.5">
          <ThemeToggle />
          <UserMenu />
        </div>
      </div>
    </header>
  )
}
