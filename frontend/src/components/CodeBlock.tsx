import { Check, Copy } from "lucide-react"
import { useEffect, useState } from "react"
import { IconButton } from "./Button"

export function CodeBlock({
  code,
  label,
  className = "",
  maxHeight,
}: {
  code: string
  /** short caption shown in the header, e.g. "schema.sql" */
  label?: string
  className?: string
  maxHeight?: number | string
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(t)
  }, [copied])

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
    } catch {
      // clipboard blocked (insecure context); nothing sensible to do
    }
  }

  return (
    <div className={`group relative rounded-card border border-border bg-surface ${className}`}>
      <div className="flex h-9 items-center justify-between border-b border-border pl-3.5 pr-1">
        <span className="font-mono text-[12px] text-muted">{label ?? "sql"}</span>
        <IconButton label={copied ? "Copied" : "Copy to clipboard"} onClick={copy} className="size-7">
          {copied ? <Check size={14} className="text-lane-4" /> : <Copy size={14} strokeWidth={1.75} />}
        </IconButton>
      </div>
      <pre
        className="scrollbar-thin overflow-auto p-3.5 font-mono text-[12.5px] leading-[1.65] text-text"
        style={{ maxHeight }}
      >
        <code>{code}</code>
      </pre>
    </div>
  )
}
