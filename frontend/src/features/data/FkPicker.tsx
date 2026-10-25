import { ChevronDown } from "lucide-react"
import { useEffect, useId, useState } from "react"
import { inputClass } from "../../components/Field"
import { Spinner } from "../../components/Spinner"
import { laneVar } from "../../lib/lanes"
import type { FkOption } from "./api"
import { useFkOptions } from "./queries"

/**
 * Searchable picker for a foreign key: rows of the referenced table by their natural key (the options
 * endpoint), with the id alongside. Typing a bare number also offers "use id N" so a value that is not
 * there can be tried, and refused by the database's own FOREIGN KEY.
 */
export function FkPicker({
  wsId,
  table,
  column,
  refTable,
  refLane,
  value,
  label,
  invalid,
  inputId,
  describedBy,
  onChange,
}: {
  wsId: number
  table: string
  column: string
  refTable: string
  refLane: number
  /** the chosen id as text, "" for none */
  value: string
  /** what the chosen id stands for, when known */
  label: string | null
  invalid: boolean
  inputId: string
  describedBy?: string
  onChange: (id: string, label: string | null) => void
}) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState("")
  const [q, setQ] = useState("")
  const [active, setActive] = useState(0)
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 180)
    return () => clearTimeout(t)
  }, [text])
  const opts = useFkOptions(wsId, table, column, q, open)

  const options: (FkOption & { raw?: boolean })[] = [...(opts.data ?? [])]
  const typedId = text.trim()
  if (/^\d+$/.test(typedId) && !options.some((o) => String(o.id) === typedId))
    options.push({ id: Number(typedId), label: `Use id ${typedId}`, raw: true })

  const choose = (o: FkOption & { raw?: boolean }) => {
    onChange(String(o.id), o.raw ? null : o.label)
    setOpen(false)
    setText("")
  }

  const shown = open ? text : value === "" ? "" : (label ?? `id ${value}`)

  return (
    <div className="relative">
      <span
        aria-hidden
        className="pointer-events-none absolute left-3 top-1/2 size-2 -translate-y-1/2 rounded-full"
        style={{ background: laneVar(refLane) }}
      />
      <input
        id={inputId}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoComplete="off"
        placeholder={`Search ${refTable}`}
        className={`${inputClass} pl-7 pr-20`}
        value={shown}
        onFocus={() => {
          setOpen(true)
          setActive(0)
        }}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          setText(e.target.value)
          setOpen(true)
          setActive(0)
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault()
            if (!open) setOpen(true)
            const n = options.length
            if (n) setActive((a) => (a + (e.key === "ArrowDown" ? 1 : n - 1)) % n)
          } else if (e.key === "Enter" && open) {
            e.preventDefault()
            if (options[active]) choose(options[active])
          } else if (e.key === "Escape" && open) {
            e.stopPropagation() // close the list, not the drawer
            e.preventDefault()
            setOpen(false)
            setText("")
          } else if (e.key === "Backspace" && !open && value !== "") {
            onChange("", null)
          }
        }}
      />
      <span className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2 text-faint">
        {value !== "" && !open && label !== null && <span className="font-mono text-[11.5px]">#{value}</span>}
        {open && opts.isFetching ? <Spinner size={13} /> : <ChevronDown size={14} />}
      </span>
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="dc-pop scrollbar-thin absolute inset-x-0 top-[calc(100%+4px)] z-30 max-h-64 overflow-auto rounded-control border border-border-strong bg-raised py-1 shadow-[var(--shadow-pop)]"
        >
          {options.length === 0 && (
            <li className="px-3 py-2 text-[13px] text-muted">
              {opts.isPending ? "Loading" : `No ${refTable} match “${typedId}”. Type an id to try one anyway.`}
            </li>
          )}
          {options.map((o, i) => (
            <li
              key={`${o.raw ? "raw" : "opt"}-${o.id}`}
              role="option"
              aria-selected={i === active}
              // mousedown, not click: it lands before the input's blur closes the list
              onMouseDown={(e) => {
                e.preventDefault()
                choose(o)
              }}
              onMouseEnter={() => setActive(i)}
              className={
                "flex cursor-pointer items-center justify-between gap-3 px-3 py-1.5 text-[13.5px] " +
                (i === active ? "bg-hover text-text" : "text-muted") +
                (o.raw ? " border-t border-border italic" : "")
              }
            >
              <span className="truncate">{o.label}</span>
              {!o.raw && <span className="shrink-0 font-mono text-[11.5px] text-faint">#{o.id}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
