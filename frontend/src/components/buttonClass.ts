export type Variant = "primary" | "secondary" | "ghost" | "danger"
export type Size = "sm" | "md"

export const base =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-control font-medium select-none " +
  "transition-[background-color,border-color,color,opacity,transform] duration-150 active:scale-[0.97] " +
  "disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"

export const variants: Record<Variant, string> = {
  primary: "bg-accent text-on-accent hover:bg-[color-mix(in_oklab,var(--accent)_86%,var(--text))]",
  secondary: "border border-border-strong bg-raised text-text hover:bg-hover",
  ghost: "text-muted hover:bg-hover hover:text-text",
  danger:
    "border border-[color-mix(in_oklab,var(--danger)_40%,transparent)] text-danger " +
    "hover:bg-[color-mix(in_oklab,var(--danger)_12%,transparent)]",
}

export const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-10 px-4 text-[14px]",
}

export function buttonClass(variant: Variant = "secondary", size: Size = "md") {
  return `${base} ${variants[variant]} ${sizes[size]}`
}
