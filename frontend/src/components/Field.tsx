import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react"

export const inputClass =
  "h-10 w-full rounded-control border border-border-strong bg-raised px-3 text-[14px] text-text " +
  "placeholder:text-faint transition-[border-color,box-shadow] duration-150 outline-none " +
  "hover:border-[color-mix(in_oklab,var(--text)_22%,var(--border-strong))] " +
  "focus:border-accent focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_22%,transparent)] " +
  "aria-[invalid=true]:border-danger"

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  hint?: ReactNode
  error?: string | null
  trailing?: ReactNode
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, hint, error, trailing, id, className = "", ...rest },
  ref,
) {
  const autoId = useId()
  const inputId = id ?? autoId
  const msgId = `${inputId}-msg`
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={inputId} className="text-[13px] font-medium text-text">
          {label}
        </label>
        {trailing}
      </div>
      <input
        ref={ref}
        id={inputId}
        className={inputClass}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? msgId : undefined}
        {...rest}
      />
      {(error || hint) && (
        <p id={msgId} className={`text-[12.5px] ${error ? "text-danger" : "text-muted"}`}>
          {error || hint}
        </p>
      )}
    </div>
  )
})
