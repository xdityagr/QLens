import {
  ArrowRight,
  Calendar,
  FileSpreadsheet,
  FileUp,
  Hash,
  RefreshCw,
  ToggleLeft,
  Type,
  X,
  type LucideIcon,
} from "lucide-react"
import { useRef, useState, type DragEvent } from "react"
import { Link, useNavigate } from "react-router"
import { Badge } from "../../components/Badge"
import { Button } from "../../components/Button"
import { buttonClass } from "../../components/buttonClass"
import { Card } from "../../components/Card"
import { DataGrid } from "../../components/DataGrid"
import { EmptyState } from "../../components/EmptyState"
import { NoiseBackdrop } from "../../components/NoiseBackdrop"
import { Spinner } from "../../components/Spinner"
import { fmtInt } from "../../lib/format"
import type { ColumnOut, DatasetDetailOut, InferredType, SampleName } from "../../lib/types"
import { ActionError, MockGap } from "../analyze/bits"
import { isMockGap } from "../analyze/util"
import { useRunAnalysis } from "../analyze/queries"
import { useWorkspaceContext } from "../workspaces/context"
import { StepHeader } from "../workspaces/StepHeader"
import { useDataset, useImportDataset, type ImportSource } from "./queries"

const MAX_BYTES = 20 * 1024 * 1024
const ACCEPT = ".csv,.tsv,.txt,.xlsx"

interface Sample {
  name: SampleName
  title: string
  blurb: string
  rows: number
  headers: string[]
}

// Shapes of the bundled samples (backend qlens/samples/generate.py); counts are fixed by its seed.
const SAMPLES: Sample[] = [
  {
    name: "fee_register",
    title: "Coaching fee register",
    blurb: "300 students over ten months, with a few names typed two ways and a teacher's old phone number.",
    rows: 3000,
    headers: [
      "Student Name",
      "Student Phone",
      "Batch",
      "Teacher",
      "Teacher Phone",
      "Month",
      "Fee Paid",
      "Payment Mode",
    ],
  },
  {
    name: "kirana_sales",
    title: "Kirana sales",
    blurb: "600 bills from a corner shop, with an outdated price on one item and a customer's name in two spellings.",
    rows: 2009,
    headers: ["Bill No", "Date", "Customer", "Customer Phone", "Item", "Category", "Unit Price", "Qty", "Amount"],
  },
  {
    name: "hostel_mess",
    title: "Hostel mess",
    blurb: "Three meals a day for 60 students over two weeks, with one warden's name written without its full stop.",
    rows: 2520,
    headers: ["Room", "Student", "Hostel Block", "Warden", "Date", "Meal", "Menu Item", "Attended"],
  },
]

const TYPE_META: Record<InferredType, { label: string; icon: LucideIcon }> = {
  integer: { label: "integer", icon: Hash },
  numeric: { label: "numeric", icon: Hash },
  date: { label: "date", icon: Calendar },
  boolean: { label: "boolean", icon: ToggleLeft },
  text: { label: "text", icon: Type },
}

export function ImportPage() {
  const { workspace } = useWorkspaceContext()
  const ds = useDataset(workspace.id)
  const [replacing, setReplacing] = useState(false)

  const dataset = ds.data
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-8 sm:py-12">
      <StepHeader step="import" actions={dataset && !replacing && <AnalyzeAction dataset={dataset} />} />

      {ds.isPending ? (
        <div className="grid h-60 place-items-center text-muted">
          <Spinner size={20} />
        </div>
      ) : ds.error ? (
        isMockGap(ds.error) ? (
          <MockGap />
        ) : (
          <EmptyState title="Couldn't load this sheet" lanes={[7, 3]}>
            {ds.error.message}
          </EmptyState>
        )
      ) : !dataset || replacing ? (
        <Chooser
          replacing={dataset && replacing ? dataset : null}
          onCancel={() => setReplacing(false)}
          onDone={() => setReplacing(false)}
        />
      ) : (
        <DatasetView dataset={dataset} onReplace={() => setReplacing(true)} />
      )}
    </div>
  )
}

/** "Analyze" runs the analysis and moves on; once it exists, it just opens it. */
function AnalyzeAction({ dataset }: { dataset: DatasetDetailOut }) {
  const { workspace } = useWorkspaceContext()
  const run = useRunAnalysis(workspace.id)
  const navigate = useNavigate()
  const to = `/w/${workspace.id}/analyze`
  if (dataset.status !== "imported")
    return (
      <Link to={to} className={buttonClass("primary")}>
        Open analysis
        <ArrowRight size={15} />
      </Link>
    )
  return (
    <>
      <Button
        variant="primary"
        loading={run.isPending}
        onClick={() => run.mutate(undefined, { onSuccess: () => navigate(to) })}
      >
        {run.isPending ? "Analyzing" : "Analyze"}
      </Button>
      <ActionError error={run.error} />
    </>
  )
}

// ---- choosing a sheet ----------------------------------------------------------

function Chooser({
  replacing,
  onCancel,
  onDone,
}: {
  replacing: DatasetDetailOut | null
  onCancel: () => void
  onDone: () => void
}) {
  const { workspace } = useWorkspaceContext()
  const imp = useImportDataset(workspace.id)
  const [localError, setLocalError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)

  function start(src: ImportSource) {
    setLocalError(null)
    if (src.kind === "file") {
      const ext = src.file.name.split(".").pop()?.toLowerCase() ?? ""
      if (!["csv", "tsv", "txt", "xlsx"].includes(ext)) return setLocalError("Upload a .csv or .xlsx file.")
      if (src.file.size > MAX_BYTES) return setLocalError("The file is larger than 20 MB.")
      if (src.file.size === 0) return setLocalError("The file is empty.")
    }
    setPending(src.kind === "file" ? src.file.name : SAMPLES.find((s) => s.name === src.name)!.title)
    imp.mutate(src, { onSuccess: onDone, onSettled: () => setPending(null) })
  }

  const error = localError ?? (imp.error ? imp.error.message : null)

  return (
    <div className="flex flex-col gap-10">
      {replacing && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface px-4 py-3 text-[14px]">
          <p className="text-muted">
            Importing replaces <span className="font-mono text-text">{replacing.original_filename}</span>
            {replacing.status === "imported"
              ? "."
              : replacing.status === "analyzed"
                ? " and discards its analysis and fixes."
                : " and drops the tables applied from it."}
          </p>
          <Button variant="ghost" size="sm" icon={<X size={14} />} onClick={onCancel} disabled={imp.isPending}>
            Keep current sheet
          </Button>
        </div>
      )}

      <DropZone busy={pending} error={error} onFile={(file) => start({ kind: "file", file })} />

      <section aria-labelledby="samples-h">
        <h3 id="samples-h" className="text-[17px] font-medium tracking-[-0.02em] text-text">
          Or start from a sample
        </h3>
        <p className="mt-1 text-[14px] text-muted">Made-up sheets with the kind of mistakes real registers have.</p>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          {SAMPLES.map((s) => (
            <SampleCard
              key={s.name}
              sample={s}
              disabled={!!pending}
              onPick={() => start({ kind: "sample", name: s.name })}
            />
          ))}
        </div>
      </section>
    </div>
  )
}

function DropZone({ busy, error, onFile }: { busy: string | null; error: string | null; onFile: (f: File) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  function drop(e: DragEvent) {
    e.preventDefault()
    setOver(false)
    const f = e.dataTransfer.files[0]
    if (f && !busy) onFile(f)
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        if (!busy) setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      className={
        "relative isolate flex flex-col items-center justify-center gap-4 overflow-hidden rounded-card border-[1.5px] border-dashed px-6 py-12 text-center transition-colors duration-150 " +
        (over
          ? "border-accent bg-[color-mix(in_oklab,var(--accent)_7%,transparent)]"
          : "border-border-strong bg-surface")
      }
    >
      <NoiseBackdrop lanes={[0, 1]} intensity={over ? 0.16 : 0.08} placement="center" />
      <div className="relative grid size-12 place-items-center rounded-full border border-border-strong bg-raised text-muted">
        {busy ? <Spinner size={18} /> : <FileUp size={20} strokeWidth={1.5} />}
      </div>
      {busy ? (
        <div aria-live="polite" className="relative">
          <p className="text-[16px] font-medium text-text">Importing {busy}</p>
          <p className="mt-1 text-[14px] text-muted">Reading every row and working out each column's type.</p>
        </div>
      ) : (
        <div className="relative">
          <p className="text-[17px] font-medium tracking-[-0.015em] text-text">Drop a spreadsheet here</p>
          <p className="mt-1 text-[14px] text-muted">
            CSV or Excel (.xlsx, first sheet). Up to 20 MB, 100,000 rows and 60 columns.
          </p>
        </div>
      )}
      {!busy && (
        <Button className="relative" icon={<FileSpreadsheet size={15} />} onClick={() => input.current?.click()}>
          Choose a file
        </Button>
      )}
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ""
          if (f) onFile(f)
        }}
      />
      {error && (
        <p role="alert" className="relative text-[14px] text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

function SampleCard({ sample, disabled, onPick }: { sample: Sample; disabled: boolean; onPick: () => void }) {
  const shown = sample.headers.slice(0, 4)
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onPick}
      className="group flex flex-col rounded-card border border-border bg-surface p-5 text-left transition-colors duration-150 hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="text-[16px] font-medium tracking-[-0.015em] text-text">{sample.title}</span>
      <span className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{sample.blurb}</span>
      {/* the sheet's real header row, so you can see what you're importing */}
      <span className="mb-5 mt-4 flex flex-wrap gap-1.5" aria-label="Columns">
        {shown.map((h) => (
          <span
            key={h}
            className="rounded-[5px] border border-border bg-raised px-1.5 py-0.5 font-mono text-[11.5px] text-muted"
          >
            {h}
          </span>
        ))}
        <span className="px-1 py-0.5 font-mono text-[11.5px] text-faint">+{sample.headers.length - shown.length}</span>
      </span>
      <span className="mt-auto flex items-center justify-between gap-3 border-t border-border pt-3.5">
        <span className="flex items-baseline gap-3 text-[13px] text-muted">
          <span>
            <span className="num text-text">{fmtInt(sample.rows)}</span> rows
          </span>
          <span>
            <span className="num text-text">{sample.headers.length}</span> columns
          </span>
        </span>
        <span className="text-[13px] font-medium text-accent">Import</span>
      </span>
    </button>
  )
}

// ---- the imported sheet ----------------------------------------------------------

function DatasetView({ dataset, onReplace }: { dataset: DatasetDetailOut; onReplace: () => void }) {
  const byName = new Map(dataset.columns.map((c) => [c.name, c]))
  const gridCols = dataset.preview.columns.map((name) => {
    const c = byName.get(name)
    return {
      name,
      label: c?.label,
      numeric: c?.inferred_type === "integer" || c?.inferred_type === "numeric",
    }
  })

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-y border-border py-4">
        <div className="flex min-w-0 items-center gap-3">
          <FileSpreadsheet size={18} strokeWidth={1.5} className="shrink-0 text-muted" />
          <span className="truncate font-mono text-[14px] text-text">{dataset.original_filename}</span>
          <Badge lane={dataset.source === "sample" ? 1 : 0}>
            {dataset.source === "sample" ? "Sample" : "Uploaded"}
          </Badge>
        </div>
        <span className="flex items-baseline gap-4 text-[13.5px] text-muted">
          <span>
            <span className="num text-text">{fmtInt(dataset.row_count)}</span> rows
          </span>
          <span>
            <span className="num text-text">{fmtInt(dataset.column_count)}</span> columns
          </span>
        </span>
        <Button variant="ghost" size="sm" className="sm:ml-auto" icon={<RefreshCw size={14} />} onClick={onReplace}>
          Import a different sheet
        </Button>
      </div>

      <section aria-labelledby="cols-h">
        <h3 id="cols-h" className="text-[17px] font-medium tracking-[-0.02em] text-text">
          Columns
        </h3>
        <p className="mt-1 max-w-[70ch] text-[14px] text-muted">
          Types are inferred from every value in the column. Each header gets a SQL-safe name, shown under it, that the
          later steps use.
        </p>
        <ColumnTable columns={dataset.columns} rows={dataset.row_count} />
      </section>

      <section aria-labelledby="preview-h">
        <h3 id="preview-h" className="flex items-baseline gap-2 text-[17px] font-medium tracking-[-0.02em] text-text">
          First {fmtInt(dataset.preview.rows.length)} rows
          <span className="text-[13.5px] font-normal tracking-normal text-muted">
            of <span className="num">{fmtInt(dataset.row_count)}</span>
          </span>
        </h3>
        <DataGrid className="mt-4" columns={gridCols} rows={dataset.preview.rows} maxHeight={560} />
      </section>
    </div>
  )
}

function ColumnTable({ columns, rows }: { columns: ColumnOut[]; rows: number }) {
  return (
    <Card className="scrollbar-thin mt-4 overflow-x-auto">
      <table className="w-full min-w-[760px] border-separate border-spacing-0 text-[13.5px]">
        <thead>
          <tr className="text-left text-[12.5px] text-muted">
            <th scope="col" className="border-b border-border px-4 py-2.5 font-normal">
              Column
            </th>
            <th scope="col" className="border-b border-border px-4 py-2.5 font-normal">
              Type
            </th>
            <th scope="col" className="border-b border-border px-4 py-2.5 text-right font-normal">
              Empty
            </th>
            <th scope="col" className="border-b border-border px-4 py-2.5 text-right font-normal">
              Distinct
            </th>
            <th scope="col" className="w-[44%] border-b border-border px-4 py-2.5 font-normal">
              Most common values
            </th>
          </tr>
        </thead>
        <tbody>
          {columns.map((c, i) => {
            const T = TYPE_META[c.inferred_type]
            const last = i === columns.length - 1
            const cell = `px-4 py-3 align-top ${last ? "" : "border-b border-border"}`
            return (
              <tr key={c.id}>
                <td className={cell}>
                  <div className="text-text">{c.label}</div>
                  <div className="font-mono text-[12px] text-faint">{c.name}</div>
                </td>
                <td className={cell}>
                  <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-border-strong px-2 font-mono text-[11.5px] text-text">
                    <T.icon size={12} strokeWidth={1.75} className="text-muted" />
                    {T.label}
                  </span>
                </td>
                <td className={`${cell} text-right`}>
                  <span className={`num ${c.null_count ? "text-text" : "text-faint"}`}>{fmtInt(c.null_count)}</span>
                  {c.null_count > 0 && (
                    <div className="num text-[11.5px] text-faint">{((c.null_count / rows) * 100).toFixed(1)}%</div>
                  )}
                </td>
                <td className={`${cell} text-right`}>
                  <span className="num text-text">{fmtInt(c.distinct_count)}</span>
                  {c.distinct_count === rows && <div className="text-[11.5px] text-faint">all unique</div>}
                </td>
                <td className={cell}>
                  <div className="flex flex-wrap gap-1.5">
                    {c.sample_values.map((v, j) => (
                      <span
                        key={j}
                        className="max-w-[16rem] truncate whitespace-pre rounded-[5px] bg-raised px-1.5 py-0.5 font-mono text-[12px] text-muted ring-1 ring-border"
                      >
                        {v}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Card>
  )
}
