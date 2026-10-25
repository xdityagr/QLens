import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react"
import { Spinner } from "./Spinner"
import { base, sizes, variants, type Size, type Variant } from "./buttonClass"

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, className = "", children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={14} /> : icon}
      {children}
    </button>
  )
})

export function IconButton({
  label,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={
        "inline-flex size-8 items-center justify-center rounded-control text-muted transition-colors " +
        `duration-150 hover:bg-hover hover:text-text ${className}`
      }
      {...rest}
    >
      {children}
    </button>
  )
}
