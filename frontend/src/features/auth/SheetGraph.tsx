import type { CSSProperties, ReactNode } from "react"
import { laneVar } from "../../lib/lanes"

/**
 * Sign-in illustration drawn as a GitLens-style commit graph: one sheet on the
 * main lane branches into a lane per generated table, then merges back when the
 * lossless check passes. Example data from the coaching-fees sample.
 */

const ROW = 50
const LANE_GAP = 20
const X0 = 14

interface Row {
  lane: number
  title: string
  meta: ReactNode
  merge?: boolean
}

const id = (s: string) => <code className="text-[0.95em] text-text/80">{s}</code>

const ROWS: Row[] = [
  { lane: 0, title: "Imported fees_2025.xlsx", meta: "3,000 rows, 14 columns" },
  { lane: 0, title: "Found 12 dependencies", meta: <>{id("student_id")} determines name, phone and batch</> },
  { lane: 0, title: "Fixed 29 conflicting values", meta: <>{id("teacher_phone")} set to the most common value</> },
  { lane: 1, title: "Created students", meta: <>key {id("student_id")}, 480 rows</> },
  { lane: 2, title: "Created teachers", meta: <>key {id("teacher_id")}, 18 rows</> },
  { lane: 3, title: "Created batches", meta: <>key {id("batch_code")}, 24 rows</> },
  { lane: 4, title: "Created payments", meta: "3,000 rows, references students and batches" },
  { lane: 0, title: "Lossless check passed", meta: "3,000 of 3,000 rows rebuilt by joining back", merge: true },
]

const BRANCH_FROM = 2
const MERGE_AT = ROWS.length - 1
const y = (i: number) => i * ROW + ROW / 2
const x = (lane: number) => X0 + lane * LANE_GAP
const WIDTH = x(4) + 14
const HEIGHT = ROWS.length * ROW

function branchPath(lane: number) {
  const a = y(BRANCH_FROM)
  const b = y(MERGE_AT)
  const r = ROW
  return (
    `M ${x(0)} ${a} C ${x(0)} ${a + r * 0.55}, ${x(lane)} ${a + r * 0.45}, ${x(lane)} ${a + r} ` +
    `L ${x(lane)} ${b - r} C ${x(lane)} ${b - r * 0.45}, ${x(0)} ${b - r * 0.55}, ${x(0)} ${b}`
  )
}

const draw = (delay: number): CSSProperties => ({
  strokeDasharray: 1,
  strokeDashoffset: 1,
  ["--len" as string]: 1,
  animation: `lane-draw 900ms cubic-bezier(.4,0,.2,1) ${delay}ms forwards`,
})

export function SheetGraph() {
  return (
    <div className="flex">
      <svg width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} fill="none" aria-hidden className="shrink-0">
        <path
          d={`M ${x(0)} ${y(0)} L ${x(0)} ${y(MERGE_AT)}`}
          pathLength={1}
          stroke={laneVar(0)}
          strokeWidth={2}
          style={draw(0)}
        />
        {[1, 2, 3, 4].map((lane) => (
          <path
            key={lane}
            d={branchPath(lane)}
            pathLength={1}
            stroke={laneVar(lane)}
            strokeWidth={2}
            strokeLinecap="round"
            style={draw(260 + lane * 90)}
          />
        ))}
        {ROWS.map((r, i) => (
          <g
            key={i}
            style={{
              transformOrigin: `${x(r.lane)}px ${y(i)}px`,
              opacity: 0,
              animation: `node-in 260ms ease-out ${120 + i * 85}ms forwards`,
            }}
          >
            {r.merge ? (
              <>
                <circle cx={x(r.lane)} cy={y(i)} r={9} fill="var(--bg)" stroke={laneVar(r.lane)} strokeWidth={2} />
                <circle cx={x(r.lane)} cy={y(i)} r={3.5} fill={laneVar(r.lane)} />
              </>
            ) : (
              <circle cx={x(r.lane)} cy={y(i)} r={5.5} fill={laneVar(r.lane)} stroke="var(--bg)" strokeWidth={2.5} />
            )}
          </g>
        ))}
      </svg>
      <ol className="min-w-0 flex-1">
        {ROWS.map((r, i) => (
          <li
            key={i}
            className="flex flex-col justify-center pl-3"
            style={{ height: ROW, opacity: 0, animation: `row-in 300ms ease-out ${160 + i * 85}ms forwards` }}
          >
            <span className="flex items-center gap-2 truncate text-[14px] font-medium text-text">
              {r.title}
            </span>
            <span className="truncate text-[12.5px] text-muted">{r.meta}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
