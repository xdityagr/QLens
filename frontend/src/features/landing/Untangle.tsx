import { useEffect, useState } from "react"
import { laneAlpha, laneVar } from "../../lib/lanes"
import { useInView, useReducedMotion } from "../../lib/reveal"

/**
 * The landing hero: a wide fee sheet whose columns visibly separate into four related tables.
 * Every cell is its own SVG group that moves with a CSS transform, so the whole thing is
 * transform/opacity only. Duplicate rows glide onto the row they repeat and fade out.
 */

type ColKey = "sn" | "sp" | "b" | "t" | "tp" | "m" | "f"

const COLS: Record<ColKey, { label: string; ident: string; w: number }> = {
  sn: { label: "Student Name", ident: "student_name", w: 100 },
  sp: { label: "Phone", ident: "student_phone", w: 104 },
  b: { label: "Batch", ident: "batch", w: 62 },
  t: { label: "Teacher", ident: "teacher", w: 82 },
  tp: { label: "Teacher Ph.", ident: "teacher_phone", w: 104 },
  m: { label: "Month", ident: "month", w: 52 },
  f: { label: "Fee Paid", ident: "fee_paid", w: 70 },
}
const SHEET_ORDER: ColKey[] = ["sn", "sp", "b", "t", "tp", "m", "f"]

const ROWS: Record<ColKey, string>[] = [
  { sn: "Riya Sharma", sp: "98290 11223", b: "JEE-A", t: "Mr. Verma", tp: "94140 55120", m: "Jul", f: "4500" },
  { sn: "Aman Gupta", sp: "99500 44871", b: "JEE-A", t: "Mr. Verma", tp: "94140 55120", m: "Jul", f: "4500" },
  { sn: "Riya Sharma", sp: "98290 11223", b: "JEE-A", t: "Mr. Verma", tp: "94140 55120", m: "Aug", f: "4500" },
  { sn: "Kabir Jain", sp: "97830 20915", b: "NEET-B", t: "Ms. Rao", tp: "98870 31402", m: "Jul", f: "5200" },
]

interface TableDef {
  name: string
  lane: number
  x: number
  y: number
  cols: ColKey[]
}
// Order matters: the first table holding a column shows it while it is still one sheet.
const TABLES: TableDef[] = [
  { name: "students", lane: 0, x: 8, y: 20, cols: ["sn", "sp", "b"] },
  { name: "batches", lane: 1, x: 336, y: 20, cols: ["b", "t"] },
  { name: "teachers", lane: 2, x: 404, y: 190, cols: ["t", "tp"] },
  { name: "payments", lane: 3, x: 8, y: 190, cols: ["sn", "m", "f"] },
]

const SHEET_X0 = 13
const SHEET_Y = 128
const HEAD_H = 24
const ROW_H = 22
const TITLE_H = 22

const sheetX: Record<ColKey, number> = (() => {
  const out = {} as Record<ColKey, number>
  let x = SHEET_X0
  for (const k of SHEET_ORDER) {
    out[k] = x
    x += COLS[k].w
  }
  return out
})()
const SHEET_W = SHEET_ORDER.reduce((s, k) => s + COLS[k].w, 0)

const primaryTable: Record<ColKey, string> = (() => {
  const out = {} as Record<ColKey, string>
  for (const t of TABLES) for (const c of t.cols) if (!out[c]) out[c] = t.name
  return out
})()
const laneOfCol = (c: ColKey) => TABLES.find((t) => t.name === primaryTable[c])!.lane

function colOffset(t: TableDef, c: ColKey) {
  let x = 0
  for (const k of t.cols) {
    if (k === c) return x
    x += COLS[k].w
  }
  return x
}
const tableW = (t: TableDef) => t.cols.reduce((s, k) => s + COLS[k].w, 0)

/** For each table: row index -> slot of the first row carrying the same values, and the distinct rows. */
function dedupe(t: TableDef) {
  const keyOf = (r: number) => t.cols.map((c) => ROWS[r][c]).join("|")
  const first = new Map<string, number>()
  const slotOf: number[] = []
  const keep: boolean[] = []
  ROWS.forEach((_, r) => {
    const k = keyOf(r)
    if (!first.has(k)) {
      first.set(k, first.size)
      keep.push(true)
    } else keep.push(false)
    slotOf.push(first.get(k)!)
  })
  return { slotOf, keep, count: first.size }
}
const DEDUPE = Object.fromEntries(TABLES.map((t) => [t.name, dedupe(t)]))
const tableH = (t: TableDef) => TITLE_H + HEAD_H + DEDUPE[t.name].count * ROW_H

// Dependencies drawn over the sheet header in the second beat.
const ARCS: { from: ColKey; to: ColKey; lane: number }[] = [
  { from: "sn", to: "sp", lane: 0 },
  { from: "sn", to: "b", lane: 0 },
  { from: "b", to: "t", lane: 1 },
  { from: "t", to: "tp", lane: 2 },
]
const colCenter = (c: ColKey) => sheetX[c] + COLS[c].w / 2

const T = (x: number, y: number) => `translate(${x}px, ${y}px)`
const EASE = "cubic-bezier(.7,0,.18,1)"

export type Phase = 0 | 1 | 2
const CAPTIONS: Record<Phase, string> = {
  0: "As imported: one wide sheet, every fact repeated on every row.",
  1: "Dependencies found: a student decides their phone and batch, a batch its teacher.",
  2: "Split into four related tables. Repeats collapse; foreign keys keep them joined.",
}
const HOLD: Record<Phase, number> = { 0: 2600, 1: 2900, 2: 5200 }

export function Untangle({ className = "" }: { className?: string }) {
  const reduced = useReducedMotion()
  const [ref, visible] = useInView<HTMLDivElement>({ once: false, threshold: 0.15 })
  const [phase, setPhase] = useState<Phase>(0)
  const shown: Phase = reduced ? 2 : phase

  useEffect(() => {
    if (reduced || !visible) return
    const id = window.setTimeout(() => setPhase((p) => ((p + 1) % 3) as Phase), HOLD[phase])
    return () => window.clearTimeout(id)
  }, [phase, visible, reduced])

  const split = shown === 2
  const tinted = shown >= 1

  return (
    <div ref={ref} className={className}>
      <svg
        viewBox="0 0 600 336"
        className="block h-auto w-full overflow-visible"
        role="img"
        aria-label="A fee register sheet with seven columns separating into four tables: students, batches, teachers and payments, linked by foreign keys."
        style={{ fontFamily: "var(--font-code)" }}
      >
        {/* sheet chrome: fades out as the columns leave */}
        <g style={{ opacity: split ? 0 : 1, transition: "opacity 500ms ease" }}>
          <text x={SHEET_X0} y={SHEET_Y + HEAD_H + ROWS.length * ROW_H + 20} fontSize={11} fill="var(--muted)">
            fee_register.csv
          </text>
          <rect
            x={SHEET_X0 - 0.5}
            y={SHEET_Y - 0.5}
            width={SHEET_W + 1}
            height={HEAD_H + ROWS.length * ROW_H + 1}
            rx={4}
            fill="var(--surface)"
            stroke="var(--border-strong)"
          />
          {ROWS.map((_, r) => (
            <line
              key={r}
              x1={SHEET_X0}
              x2={SHEET_X0 + SHEET_W}
              y1={SHEET_Y + HEAD_H + r * ROW_H}
              y2={SHEET_Y + HEAD_H + r * ROW_H}
              stroke="var(--border)"
            />
          ))}
          {SHEET_ORDER.slice(1).map((c) => (
            <line
              key={c}
              x1={sheetX[c]}
              x2={sheetX[c]}
              y1={SHEET_Y}
              y2={SHEET_Y + HEAD_H + ROWS.length * ROW_H}
              stroke="var(--border)"
            />
          ))}
        </g>

        {/* dependency arcs over the header */}
        <g style={{ opacity: shown === 1 ? 1 : 0, transition: "opacity 400ms ease" }}>
          {ARCS.map((a, i) => {
            const x1 = colCenter(a.from)
            const x2 = colCenter(a.to)
            const lift = 22 + Math.abs(x2 - x1) * 0.12
            return (
              <g key={i}>
                <path
                  d={`M${x1} ${SHEET_Y - 4} C${x1} ${SHEET_Y - 4 - lift} ${x2} ${SHEET_Y - 4 - lift} ${x2} ${SHEET_Y - 6}`}
                  fill="none"
                  stroke={laneVar(a.lane)}
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  pathLength={1}
                  strokeDasharray="1 1"
                  style={{
                    strokeDashoffset: shown === 1 ? 0 : 1,
                    transition: `stroke-dashoffset 700ms ${EASE} ${180 + i * 220}ms`,
                  }}
                />
                <circle
                  cx={x2}
                  cy={SHEET_Y - 6}
                  r={2.6}
                  fill={laneVar(a.lane)}
                  style={{ opacity: shown === 1 ? 1 : 0, transition: `opacity 200ms ease ${700 + i * 220}ms` }}
                />
              </g>
            )
          })}
        </g>

        {/* table cards */}
        {TABLES.map((t, ti) => (
          <g
            key={t.name}
            style={{
              opacity: split ? 1 : 0,
              transition: `opacity 500ms ease ${split ? 520 + ti * 60 : 0}ms`,
            }}
          >
            <rect
              x={t.x - 0.5}
              y={t.y - 0.5}
              width={tableW(t) + 1}
              height={tableH(t) + 1}
              rx={7}
              fill="var(--surface)"
              stroke={laneAlpha(t.lane, 0.55)}
            />
            <rect x={t.x} y={t.y} width={3} height={tableH(t)} rx={1.5} fill={laneVar(t.lane)} />
            <text x={t.x + 12} y={t.y + 15} fontSize={11.5} fontWeight={600} fill={laneVar(t.lane)}>
              {t.name}
            </text>
          </g>
        ))}

        {/* foreign keys */}
        <g fill="none" strokeWidth={1.5} strokeLinecap="round">
          {FKS.map((fk, i) => (
            <path
              key={i}
              d={fk.d}
              stroke={laneVar(fk.lane)}
              pathLength={1}
              strokeDasharray="1 1"
              style={{
                strokeDashoffset: split ? 0 : 1,
                opacity: split ? 0.9 : 0,
                transition: split
                  ? `stroke-dashoffset 650ms ${EASE} ${1150 + i * 180}ms, opacity 100ms linear ${1150 + i * 180}ms`
                  : "opacity 300ms ease",
              }}
            />
          ))}
        </g>

        {/* headers and cells */}
        {TABLES.map((t) =>
          t.cols.map((c, ci) => {
            const primary = primaryTable[c] === t.name
            const sx = sheetX[c]
            const tx = t.x + colOffset(t, c)
            const delay = (SHEET_ORDER.indexOf(c) * 45 + ci * 20) * (split ? 1 : 0.4)
            const mv = (d: number) => `transform 1050ms ${EASE} ${d}ms, opacity 450ms ease ${split ? d + 250 : 0}ms`
            const move = mv(delay)
            const head = split ? T(tx, t.y + TITLE_H) : T(sx, SHEET_Y)
            const dd = DEDUPE[t.name]
            const lane = split ? t.lane : laneOfCol(c)
            return (
              <g key={`${t.name}-${c}`}>
                <g style={{ transform: head, opacity: split || primary ? 1 : 0, transition: move }}>
                  <rect
                    width={COLS[c].w}
                    height={HEAD_H}
                    style={{
                      fill: tinted ? laneAlpha(lane, 0.16) : "var(--raised)",
                      transition: "fill 500ms ease",
                    }}
                  />
                  <text
                    x={8}
                    y={16}
                    fontSize={10.5}
                    fill="var(--text)"
                    style={{ opacity: split ? 0 : 1, transition: "opacity 300ms ease", fontFamily: "var(--font-ui)", fontWeight: 600 }}
                  >
                    {COLS[c].label}
                  </text>
                  <text
                    x={8}
                    y={16}
                    fontSize={10.5}
                    fill="var(--text)"
                    style={{ opacity: split ? 1 : 0, transition: "opacity 300ms ease 400ms" }}
                  >
                    {COLS[c].ident}
                  </text>
                </g>
                {ROWS.map((row, r) => {
                  const pos = split
                    ? T(tx, t.y + TITLE_H + HEAD_H + dd.slotOf[r] * ROW_H)
                    : T(sx, SHEET_Y + HEAD_H + r * ROW_H)
                  const op = split ? (dd.keep[r] ? 1 : 0) : primary ? 1 : 0
                  return (
                    <g key={r} style={{ transform: pos, opacity: op, transition: mv(delay + r * 30) }}>
                      <text x={8} y={15} fontSize={10.5} fill={tinted && !split && r > 0 && isRepeat(c, r) ? "var(--muted)" : "var(--text)"}>
                        {row[c]}
                      </text>
                    </g>
                  )
                })}
              </g>
            )
          }),
        )}
      </svg>
      <div className="mt-4 flex items-center gap-3">
        <div className="flex items-center gap-1.5" aria-hidden>
          {([0, 1, 2] as Phase[]).map((p) => (
            <span
              key={p}
              className="h-[3px] rounded-full transition-all duration-300"
              style={{ width: p === shown ? 22 : 8, background: p === shown ? "var(--accent)" : "var(--border-strong)" }}
            />
          ))}
        </div>
        <p className="min-h-[3em] text-[13px] leading-[1.5] text-muted sm:min-h-[1.5em]" aria-live="off">
          {CAPTIONS[shown]}
        </p>
      </div>
    </div>
  )
}

/** A value that already appeared above in the same column for the same determinant: the redundancy normalization removes. */
function isRepeat(c: ColKey, r: number) {
  if (c === "m" || c === "f" || c === "sn") return false
  return ROWS.slice(0, r).some((prev) => prev[c] === ROWS[r][c])
}

// FK paths in viewBox units, from the referencing column to the referenced key.
const FKS: { d: string; lane: number }[] = (() => {
  const [students, batches, teachers, payments] = TABLES
  const out: { d: string; lane: number }[] = []
  // payments.student_name -> students.student_name (vertical)
  const px = payments.x + COLS.sn.w / 2
  out.push({ d: `M${px} ${payments.y} V${students.y + tableH(students)}`, lane: 0 })
  // students.batch -> batches.batch (horizontal)
  const sy = students.y + TITLE_H + HEAD_H / 2
  out.push({ d: `M${students.x + tableW(students)} ${sy} H${batches.x}`, lane: 1 })
  // batches.teacher -> teachers.teacher
  const bx = batches.x + colOffset(batches, "t") + COLS.t.w / 2
  const tx = teachers.x + COLS.t.w / 2
  const by = batches.y + tableH(batches)
  out.push({ d: `M${bx} ${by} C${bx} ${by + 40} ${tx} ${teachers.y - 40} ${tx} ${teachers.y}`, lane: 2 })
  return out
})()
