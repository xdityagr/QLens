import { useQueryClient } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight, Download, Plus, Search } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useSearchParams } from "react-router"
import { Button, IconButton } from "../../components/Button"
import { EmptyState } from "../../components/EmptyState"
import { inputClass } from "../../components/Field"
import { Spinner } from "../../components/Spinner"
import { fmtInt } from "../../lib/format"
import { useReducedMotion } from "../../lib/reveal"
import { formatFilter, parseFilter, type RowFilter } from "../../lib/rowFilters"
import { diffRow } from "../../lib/rowValues"
import { dataApi } from "./api"
import { ConstraintCard } from "./ConstraintCard"
import { FilterBar } from "./FilterBar"
import { invalidateData, useRows, useWriteRow } from "./queries"
import { RowDrawer, type DrawerMode, type Saved } from "./RowDrawer"
import { RowGrid, type Pinned, type SortState } from "./RowGrid"

const PAGE_SIZES = [25, 50, 100]
const FLASH_MS = 1500
const LEAVE_MS = 260

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/**
 * One table: search, column filters (kept in the URL, so a jump from a foreign key is a link the Back button
 * undoes), CSV export, the grid with inline delete, the pager, and the side panel for a row (view, edit, add).
 * Remounted per table.
 */
export function TableView({ wsId, table, laneOf }: { wsId: number; table: string; laneOf: (t: string) => number }) {
  const qc = useQueryClient()
  const reduced = useReducedMotion()
  const [params, setParams] = useSearchParams()
  const fParams = params.getAll("f")
  const filters = fParams.map(parseFilter).filter((f): f is RowFilter => f !== null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [sort, setSort] = useState<SortState>({ sort: null, dir: "asc" })
  const [search, setSearch] = useState("")
  const q = useDebounced(search, 250)
  const view = { sort: sort.sort, dir: sort.dir, q, filters: filters.map(formatFilter) }
  const rows = useRows(wsId, table, { page, pageSize, ...view })

  const [drawer, setDrawer] = useState<DrawerMode | null>(null)
  const [pinned, setPinned] = useState<Pinned[]>([])
  const [flash, setFlash] = useState<Map<number, Set<string>>>(new Map())
  const [leaving, setLeaving] = useState<Set<number>>(new Set())
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const [deleteAttempt, setDeleteAttempt] = useState(0)
  const del = useWriteRow(wsId)
  const timers = useRef<number[]>([])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])
  const later = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, ms))

  const data = rows.data
  const lane = data?.color_index ?? laneOf(table)

  const setFilters = (next: RowFilter[]) => {
    setPage(1)
    setParams(
      (p) => {
        p.delete("f")
        next.forEach((f) => p.append("f", formatFilter(f)))
        return p
      },
      { replace: true },
    )
  }

  /** Open another table (or this one) filtered: a pushed URL, so Back returns here. */
  const jump = (target: string, filter: RowFilter) => {
    setDrawer(null)
    setParams({ table: target, f: formatFilter(filter) })
  }

  const onSort = (column: string) => {
    setPage(1)
    setSort((s) =>
      s.sort !== column
        ? { sort: column, dir: "asc" }
        : s.dir === "asc"
          ? { sort: column, dir: "desc" }
          : { sort: null, dir: "asc" },
    )
  }

  const onSaved = ({ row, labels }: Saved, mode: DrawerMode) => {
    setDrawer(null)
    const id = Number(row.id)
    if (mode.kind === "add") {
      setPinned((p) => [{ row, labels }, ...p])
    } else if (mode.kind === "edit") {
      // the edited row is on this page: mark the cells that changed once the refetch shows them
      const cols = new Set(
        diffRow(mode.row, row)
          .filter((d) => d.changed)
          .map((d) => d.column),
      )
      setFlash((f) => new Map(f).set(id, cols))
      setPinned((p) => p.map((x) => (Number(x.row.id) === id ? { row, labels } : x)))
      later(
        () =>
          setFlash((f) => {
            const next = new Map(f)
            next.delete(id)
            return next
          }),
        FLASH_MS,
      )
    }
    invalidateData(qc, wsId)
  }

  /** A row is gone: let it slide out before the refetch drops it. */
  const onDeleted = (id: number) => {
    setLeaving((s) => new Set(s).add(id))
    later(
      () => {
        setPinned((p) => p.filter((x) => Number(x.row.id) !== id))
        invalidateData(qc, wsId)
      },
      reduced ? 0 : LEAVE_MS,
    )
  }

  const onDelete = (id: number) => {
    setDeleteAttempt((n) => n + 1)
    del.mutate(
      { op: "delete", table, id },
      {
        onSuccess: () => {
          setConfirmId(null)
          onDeleted(id)
        },
        onError: () => setConfirmId(null),
      },
    )
  }

  const total = data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  const narrowed = q.trim() !== "" || filters.length > 0

  return (
    <section aria-label={`Rows of ${table}`} className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 sm:max-w-[340px]">
          <Search
            size={15}
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
          />
          <input
            type="search"
            aria-label={`Search ${table}`}
            placeholder="Search text and linked names"
            className={`${inputClass} h-9 pl-9`}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
          />
        </div>
        {rows.isFetching && <Spinner size={14} className="text-muted" />}
        <div className="ml-auto flex items-center gap-2">
          <ExportButton
            url={dataApi.exportUrl(wsId, table, view)}
            table={table}
            title={
              narrowed ? "Every row that matches the search and filters, in this order" : "Every row, in this order"
            }
          />
          <Button
            variant="primary"
            size="sm"
            icon={<Plus size={15} />}
            onClick={() => setDrawer({ kind: "add" })}
            disabled={!data}
          >
            Add row
          </Button>
        </div>
      </div>

      {data && <FilterBar columns={data.columns} filters={filters} onChange={setFilters} />}

      {del.error && (
        <div className="mb-3">
          <ConstraintCard key={deleteAttempt} error={del.error} onDismiss={() => del.reset()} />
        </div>
      )}

      {rows.isPending ? (
        <div className="grid min-h-[240px] place-items-center rounded-card border border-border bg-surface text-muted">
          <Spinner size={18} />
        </div>
      ) : rows.error || !data ? (
        <EmptyState
          title={`Couldn't load ${table}`}
          lanes={[7, 3]}
          action={
            filters.length > 0 && (
              <Button size="sm" onClick={() => setFilters([])}>
                Clear filters
              </Button>
            )
          }
        >
          {rows.error?.message}
        </EmptyState>
      ) : (
        <>
          <RowGrid
            data={data}
            laneOf={laneOf}
            sort={sort}
            onSort={onSort}
            pinned={pinned}
            flash={flash}
            leaving={leaving}
            confirmId={confirmId}
            deletingId={del.isPending ? ((del.variables as { id?: number } | undefined)?.id ?? null) : null}
            onOpen={(row, labels) => setDrawer({ kind: "view", row, labels })}
            onEdit={(row, labels) => setDrawer({ kind: "edit", row, labels })}
            onJump={(target, id) => jump(target, { column: "id", op: "eq", value: String(id) })}
            onAskDelete={(id) => {
              del.reset()
              setConfirmId(id)
            }}
            onDelete={onDelete}
            onCancelDelete={() => setConfirmId(null)}
          />
          <footer className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[12.5px] text-muted">
            <p className="num">
              {total === 0 ? "0 rows" : `${fmtInt(from)}–${fmtInt(to)} of ${fmtInt(total)}`}
              {narrowed && <span className="font-sans"> matching</span>}
              {q.trim() && <span className="font-sans"> “{q.trim()}”</span>}
              {filters.length > 0 && (
                <span className="font-sans">
                  {q.trim() ? " and " : " "}
                  {filters.length === 1 ? "1 filter" : `${filters.length} filters`}
                </span>
              )}
            </p>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2">
                Rows per page
                <select
                  className="h-8 rounded-control border border-border-strong bg-raised px-2 font-mono text-[12.5px] text-text"
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value))
                    setPage(1)
                  }}
                >
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <IconButton
                label="Previous page"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="disabled:opacity-40"
              >
                <ChevronLeft size={16} />
              </IconButton>
              <span className="num min-w-[5ch] text-center text-text">
                {page} / {pages}
              </span>
              <IconButton
                label="Next page"
                disabled={page >= pages}
                onClick={() => setPage((p) => p + 1)}
                className="disabled:opacity-40"
              >
                <ChevronRight size={16} />
              </IconButton>
            </div>
          </footer>
        </>
      )}

      {data && (
        <RowDrawer
          wsId={wsId}
          table={table}
          lane={lane}
          columns={data.columns}
          laneOf={laneOf}
          mode={drawer}
          onMode={setDrawer}
          onClose={() => setDrawer(null)}
          onSaved={onSaved}
          onDeleted={(id) => {
            setDrawer(null)
            onDeleted(id)
          }}
          onJump={jump}
        />
      )}
    </section>
  )
}

// The import limit; the server stops an export there and says so in a header.
const EXPORT_CAP = 100_000

/**
 * Downloads the CSV through fetch (the session cookie goes with it) so the response header can say whether the
 * file was cut at EXPORT_CAP rows; then it says so beside the button.
 */
function ExportButton({ url, table, title }: { url: string; table: string; title: string }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  async function download() {
    setBusy(true)
    setNote(null)
    try {
      const res = await fetch(url, { credentials: "include" })
      if (!res.ok) throw new Error(`The export failed (HTTP ${res.status}).`)
      const blob = await res.blob()
      const href = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = href
      a.download = `${table}.csv`
      document.body.append(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(href), 1000)
      if (res.headers.get("X-QLens-Truncated") === "true")
        setNote(`The file holds the first ${fmtInt(EXPORT_CAP)} rows only; filter the table to export the rest.`)
    } catch (e) {
      setNote(e instanceof Error ? e.message : "The export failed.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className="relative">
      <Button size="sm" loading={busy} icon={<Download size={14} />} onClick={download} title={title}>
        Export CSV
      </Button>
      {note && (
        <span
          role="status"
          className="absolute right-0 top-full z-10 mt-1.5 w-[280px] rounded-control border border-border-strong bg-raised px-3 py-2 text-[12.5px] leading-snug text-text shadow-[var(--shadow-pop)]"
        >
          {note}{" "}
          <button
            type="button"
            className="text-muted underline underline-offset-2 hover:text-text"
            onClick={() => setNote(null)}
          >
            Dismiss
          </button>
        </span>
      )}
    </span>
  )
}
