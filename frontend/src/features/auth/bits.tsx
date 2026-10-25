import { CircleAlert } from "lucide-react"

const MOCK = import.meta.env.VITE_MOCK === "1"
// Mirrors MOCK_DEMO in lib/mock.ts; kept here so the real build never imports the mock.
const DEMO = { email: "riya@example.com", password: "qlens-demo" }

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-control border border-[color-mix(in_oklab,var(--danger)_35%,transparent)] bg-[color-mix(in_oklab,var(--danger)_8%,transparent)] px-3 py-2.5 text-[13.5px] text-danger"
    >
      <CircleAlert size={15} className="mt-[2px] shrink-0" />
      {message}
    </p>
  )
}

/** Only rendered by `npm run dev:mock`, so a real build never shows demo credentials. */
export function MockHint({ onFill }: { onFill: (demo: typeof DEMO) => void }) {
  if (!MOCK) return null
  return (
    <div className="mt-10 rounded-control border border-dashed border-border-strong px-3.5 py-3 text-[13px] text-muted">
      <p>
        Mock API is on. Demo account <code className="text-text">{DEMO.email}</code> with password{" "}
        <code className="text-text">{DEMO.password}</code>.
      </p>
      <button
        type="button"
        onClick={() => onFill(DEMO)}
        className="mt-1.5 font-medium text-accent underline-offset-4 hover:underline"
      >
        Fill in demo account
      </button>
    </div>
  )
}
