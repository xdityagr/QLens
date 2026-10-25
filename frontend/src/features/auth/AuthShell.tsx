import type { ReactNode } from "react"
import { NoiseBackdrop } from "../../components/NoiseBackdrop"
import { ThemeToggle } from "../../components/ThemeToggle"
import { Wordmark } from "../../components/Wordmark"
import { SheetGraph } from "./SheetGraph"

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <aside className="relative isolate hidden overflow-hidden border-r border-border lg:flex lg:flex-col">
        <NoiseBackdrop lanes={[0, 1]} intensity={0.2} placement="left" />
        <div className="relative flex h-14 items-center px-8">
          <Wordmark to="/login" />
        </div>
        <div className="relative flex flex-1 flex-col justify-center px-8 pb-16 xl:px-14">
          <p className="max-w-[22ch] text-balance text-[34px] font-medium leading-[1.08] tracking-[-0.035em] text-text xl:text-[40px]">
            One messy sheet in. Clean, related tables out.
          </p>
          <p className="mt-4 max-w-[46ch] text-[15px] leading-relaxed text-muted">
            QLens reads the dependencies hiding in your data and proposes a normalized PostgreSQL schema, then
            proves nothing was lost.
          </p>
          <div className="mt-10 max-w-[520px] rounded-card border border-border bg-[color-mix(in_oklab,var(--surface)_72%,transparent)] px-4 py-3 backdrop-blur-sm">
            <SheetGraph />
          </div>
          <p className="mt-3 text-[12.5px] text-faint">Example run on a coaching-centre fee register.</p>
        </div>
      </aside>

      <main className="relative isolate flex flex-col">
        <NoiseBackdrop lanes={[0, 1]} intensity={0.16} placement="top" className="lg:hidden" />
        <div className="relative flex h-14 items-center justify-between px-5 sm:px-8">
          <span className="lg:invisible">
            <Wordmark to="/login" />
          </span>
          <ThemeToggle />
        </div>
        <div className="relative flex flex-1 items-center justify-center px-5 pb-20 pt-6 sm:px-8">
          <div className="w-full max-w-[360px]">{children}</div>
        </div>
      </main>
    </div>
  )
}
