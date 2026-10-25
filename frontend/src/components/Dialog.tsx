import { X } from "lucide-react"
import { useEffect, useRef, type ReactNode } from "react"
import { IconButton } from "./Button"

/** Native <dialog> (focus trap, Esc, inert background for free), styled. */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
      aria-labelledby="dialog-title"
      className={
        "m-auto w-[min(440px,calc(100vw-32px))] rounded-card border border-border-strong bg-raised p-0 text-text " +
        "shadow-[var(--shadow-pop)] backdrop:bg-[color-mix(in_oklab,var(--bg)_70%,transparent)] backdrop:backdrop-blur-[2px] " +
        "open:animate-[pop-in_160ms_ease-out]"
      }
    >
      {open && (
        <div className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id="dialog-title" className="text-[18px] font-medium tracking-[-0.015em]">
                {title}
              </h2>
              {description && <p className="mt-1 text-[14px] text-muted">{description}</p>}
            </div>
            <IconButton label="Close" onClick={onClose} className="-mr-2 -mt-1">
              <X size={16} />
            </IconButton>
          </div>
          <div className="mt-5">{children}</div>
        </div>
      )}
    </dialog>
  )
}
