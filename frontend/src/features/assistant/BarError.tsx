import { CircleAlert, Clock, X } from "lucide-react"
import type { FriendlyError } from "./logic"

/** A failed message, next to the bar while the sidebar is closed. */
export function BarError({
  error,
  onRetry,
  onClose,
}: {
  error: FriendlyError
  onRetry: () => void
  onClose: () => void
}) {
  const rate = error.kind === "rate" || error.kind === "upstream"
  return (
    <div
      role="alert"
      className="as-toast as-glass flex min-h-10 max-w-full items-center gap-2.5 rounded-full py-1 pl-3.5 pr-1.5"
    >
      <span className={"shrink-0 " + (rate ? "text-lane-3" : "text-danger")}>
        {rate ? <Clock size={15} strokeWidth={2} /> : <CircleAlert size={15} strokeWidth={2} />}
      </span>
      <span className="min-w-0 text-[13px] leading-snug text-text">{error.message}</span>
      {error.kind !== "off" && (
        <button
          type="button"
          onClick={onRetry}
          className="h-8 shrink-0 rounded-full px-3 text-[13px] font-medium text-accent transition-colors duration-150 hover:bg-hover"
        >
          Try again
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onClose}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors duration-150 hover:bg-hover hover:text-text"
      >
        <X size={14} strokeWidth={1.75} />
      </button>
    </div>
  )
}
