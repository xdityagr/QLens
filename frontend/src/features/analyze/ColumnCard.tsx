import { KeyRound } from "lucide-react"
import type { CSSProperties } from "react"
import type { AnatomyColumn } from "../../lib/anatomy"
import { TYPE_META } from "../../lib/columnTypes"
import { fmtInt } from "../../lib/format"
import { laneAlpha, laneVar } from "../../lib/lanes"
import { KEY_COLOR } from "./util"

export type CardState = "normal" | "selected" | "related" | "dim"

/**
 * One column as an ERD-style card: sheet header, SQL identifier, type, and a key glyph when the
 * column is part of a candidate key. A lane bar on the left means it determines other columns.
 */
export function ColumnCard({
  col,
  state = "normal",
  onClick,
  className = "",
  style,
}: {
  col: AnatomyColumn
  state?: CardState
  onClick?: () => void
  className?: string
  style?: CSSProperties
}) {
  const T = col.type ? TYPE_META[col.type] : null
  const primary = col.keyRole === "primary"
  const Tag = onClick ? "button" : "div"
  const keyText =
    col.keyRole === "primary" ? "Part of the row identity" : col.keyRole === "alternate" ? "Part of another unique key" : ""

  return (
    <Tag
      {...(onClick ? { type: "button" as const, onClick, "aria-pressed": state === "selected" } : {})}
      className={
        "group relative flex h-[54px] w-[172px] flex-col justify-center rounded-[8px] border bg-raised pl-3.5 pr-2.5 text-left " +
        "transition-[opacity,transform,box-shadow,border-color] duration-200 " +
        (onClick ? "cursor-pointer hover:-translate-y-px active:translate-y-0 " : "") +
        (state === "dim" ? "opacity-35 " : "") +
        className
      }
      style={{
        borderColor: primary
          ? `color-mix(in oklab, ${KEY_COLOR} 45%, var(--border-strong))`
          : state === "selected"
            ? "var(--text)"
            : "var(--border-strong)",
        boxShadow:
          state === "selected"
            ? `0 0 0 1px var(--text), 0 0 0 5px ${col.lane !== null ? laneAlpha(col.lane, 0.22) : "color-mix(in oklab, var(--text) 12%, transparent)"}`
            : undefined,
        ...style,
      }}
    >
      {col.lane !== null && (
        <span
          aria-hidden
          className="absolute inset-y-2 left-0 w-[3px] rounded-r-full"
          style={{ background: laneVar(col.lane) }}
        />
      )}
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium leading-tight tracking-[-0.01em] text-text">
          {col.label}
        </span>
        {col.keyRole && (
          <KeyRound
            size={13}
            strokeWidth={2}
            aria-label={keyText}
            className="shrink-0"
            style={{ color: primary ? KEY_COLOR : "var(--muted)" }}
          />
        )}
      </span>
      <span className="mt-1 flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] leading-none text-faint">{col.name}</span>
        {T && (
          <span className="flex shrink-0 items-center gap-1 font-mono text-[10.5px] leading-none text-muted">
            <T.icon size={10.5} strokeWidth={1.75} aria-hidden />
            {T.label}
          </span>
        )}
      </span>

      {col.distinct !== null && (
        // profile on hover/focus; absolutely placed so nothing around it moves
        <span
          role="tooltip"
          className="pointer-events-none absolute left-1/2 top-[calc(100%+6px)] z-20 w-max -translate-x-1/2 translate-y-1 rounded-[7px] border border-border-strong bg-raised px-2.5 py-1.5 text-[12px] text-muted opacity-0 shadow-[var(--shadow-pop)] transition-[opacity,transform] duration-150 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100"
        >
          <span className="num text-text">{fmtInt(col.distinct)}</span> distinct
          <span className="mx-2 text-faint">/</span>
          <span className={`num ${col.nulls ? "text-text" : ""}`}>{fmtInt(col.nulls ?? 0)}</span> empty
          {keyText && <span className="mt-0.5 block text-[11.5px]">{keyText}</span>}
        </span>
      )}
    </Tag>
  )
}
