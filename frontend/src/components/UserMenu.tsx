import { LogOut } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useLogout, useMe } from "../features/auth/useAuth"
import { laneAlpha, laneVar } from "../lib/lanes"

function initials(name: string, email: string) {
  const src = name.trim() || email
  const parts = src.split(/[\s@._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?"
}

export function UserMenu() {
  const { data: me } = useMe()
  const logout = useLogout()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false)
    document.addEventListener("pointerdown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("pointerdown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  if (!me) return null
  const lane = me.id % 8

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${me.display_name || me.email}`}
        onClick={() => setOpen((o) => !o)}
        className="grid size-8 place-items-center rounded-full text-[11.5px] font-semibold tracking-wide transition-[box-shadow] hover:shadow-[0_0_0_3px_var(--hover)]"
        style={{ background: laneAlpha(lane, 0.18), color: laneVar(lane), boxShadow: `inset 0 0 0 1px ${laneAlpha(lane, 0.4)}` }}
      >
        {initials(me.display_name, me.email)}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-10 z-50 w-60 animate-[pop-in_120ms_ease-out] rounded-card border border-border-strong bg-raised p-1.5 shadow-[var(--shadow-pop)]"
        >
          <div className="px-2.5 pb-2 pt-1.5">
            <p className="truncate text-[14px] font-medium text-text">{me.display_name || "Signed in"}</p>
            <p className="truncate text-[12.5px] text-muted">{me.email}</p>
          </div>
          <div className="my-1 h-px bg-border" />
          <button
            role="menuitem"
            type="button"
            onClick={() => logout.mutate()}
            className="flex h-9 w-full items-center gap-2.5 rounded-[6px] px-2.5 text-left text-[14px] text-muted hover:bg-hover hover:text-text"
          >
            <LogOut size={15} strokeWidth={1.75} />
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}
