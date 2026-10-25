import type { CSSProperties, ReactNode } from "react"
import { laneAlpha, laneVar } from "../../lib/lanes"

/** Moving grain gradient: drifting lane blobs under a still grain layer. Background only. */
export function GrainField({ lanes = [0, 1, 5], strength = 0.32, className = "" }: { lanes?: number[]; strength?: number; className?: string }) {
  const [a, b, c] = lanes
  return (
    <div aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}>
      <div className="ld-blob ld-blob-a" style={{ left: "-12%", top: "-18%", width: "62%", height: "70%", background: laneAlpha(a, strength) }} />
      <div className="ld-blob ld-blob-b" style={{ right: "-14%", top: "-6%", width: "55%", height: "60%", background: laneAlpha(b, strength * 0.85) }} />
      {c !== undefined && (
        <div className="ld-blob ld-blob-c" style={{ left: "30%", bottom: "-30%", width: "48%", height: "55%", background: laneAlpha(c, strength * 0.55) }} />
      )}
      <div className="grain absolute inset-0" />
    </div>
  )
}

const d = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties

function Frame({ children, label }: { children: ReactNode; label: string }) {
  return (
    <svg viewBox="0 0 260 150" className="block h-auto w-full" role="img" aria-label={label} style={{ fontFamily: "var(--font-code)" }}>
      {children}
    </svg>
  )
}

export function ImportVisual() {
  const cols: [string, string, number][] = [
    ["Student Name", "text", 0],
    ["Batch", "text", 1],
    ["Fee Paid", "integer", 4],
    ["Paid On", "date", 3],
  ]
  return (
    <Frame label="A CSV file whose columns get SQL types: text, text, integer, date.">
      <g className="ld-fade" style={d(0)}>
        <path d="M14 38h34l12 12v52H14z" fill="var(--raised)" stroke="var(--border-strong)" />
        <path d="M48 38v12h12" fill="none" stroke="var(--border-strong)" />
        <text x={18} y={86} fontSize={9} fill="var(--muted)">
          .csv
        </text>
      </g>
      <path d="M68 70 C84 70 84 70 98 70" className="ld-draw" pathLength={1} fill="none" stroke="var(--accent)" strokeWidth={1.5} style={d(200)} />
      {cols.map(([name, type, lane], i) => (
        <g key={name} className="ld-pop" style={d(450 + i * 140)}>
          <rect x={104} y={20 + i * 28} width={146} height={22} rx={5} fill="var(--surface)" stroke="var(--border-strong)" />
          <text x={112} y={35 + i * 28} fontSize={10} fill="var(--text)" style={{ fontFamily: "var(--font-ui)" }}>
            {name}
          </text>
          <text x={244} y={35 + i * 28} fontSize={9} textAnchor="end" fill={laneVar(lane)}>
            {type}
          </text>
        </g>
      ))}
    </Frame>
  )
}

export function AnalyzeVisual() {
  const node = (x: number, y: number, label: string, lane: number, delay: number) => (
    <g className="ld-pop" style={d(delay)}>
      <rect x={x} y={y} width={64} height={22} rx={11} fill={laneAlpha(lane, 0.14)} stroke={laneAlpha(lane, 0.5)} />
      <text x={x + 32} y={y + 14.5} fontSize={9.5} textAnchor="middle" fill="var(--text)">
        {label}
      </text>
    </g>
  )
  return (
    <Frame label="Arrows show student deciding phone and batch deciding teacher; two spellings of Riya Sharma merge into one.">
      {node(8, 14, "student", 0, 0)}
      {node(8, 50, "batch", 1, 120)}
      {node(186, 14, "phone", 0, 240)}
      {node(186, 50, "teacher", 1, 360)}
      <path d="M74 25 H184" className="ld-draw" pathLength={1} fill="none" stroke={laneVar(0)} strokeWidth={1.5} style={d(500)} />
      <path d="M74 61 H184" className="ld-draw" pathLength={1} fill="none" stroke={laneVar(1)} strokeWidth={1.5} style={d(700)} />
      <path d="M178 21 l6 4 -6 4" className="ld-fade" fill="none" stroke={laneVar(0)} strokeWidth={1.5} style={d(1200)} />
      <path d="M178 57 l6 4 -6 4" className="ld-fade" fill="none" stroke={laneVar(1)} strokeWidth={1.5} style={d(1400)} />

      <line x1={8} x2={252} y1={92} y2={92} stroke="var(--border)" />
      <g className="ld-merge-a" style={d(1300)}>
        <rect x={8} y={100} width={120} height={20} rx={4} fill="var(--surface)" stroke="var(--border-strong)" />
        <text x={16} y={114} fontSize={9.5} fill="var(--text)">
          Riya Sharma
        </text>
        <text x={120} y={114} fontSize={9} textAnchor="end" fill="var(--muted)">
          38
        </text>
      </g>
      <g className="ld-merge-b" style={d(1300)}>
        <rect x={8} y={126} width={120} height={20} rx={4} fill="var(--surface)" stroke={laneAlpha(3, 0.6)} />
        <text x={16} y={140} fontSize={9.5} fill="var(--text)">
          Riya Sharma.
        </text>
        <text x={120} y={140} fontSize={9} textAnchor="end" fill="var(--muted)">
          2
        </text>
      </g>
      <text x={140} y={127} fontSize={9.5} className="ld-fade" fill={laneVar(4)} style={{ ...d(1900), fontFamily: "var(--font-ui)" }}>
        2 rows merged in
      </text>
    </Frame>
  )
}

export function DesignVisual() {
  const table = (x: number, y: number, name: string, lane: number, cols: string[], from: [string, string, string], delay: number) => (
    <g className="ld-snap" style={{ ...d(delay), "--fx": from[0], "--fy": from[1], "--fr": from[2] } as CSSProperties}>
      <rect x={x} y={y} width={84} height={18 + cols.length * 15} rx={5} fill="var(--surface)" stroke={laneAlpha(lane, 0.6)} />
      <rect x={x} y={y} width={84} height={17} rx={5} fill={laneAlpha(lane, 0.18)} />
      <text x={x + 7} y={y + 12} fontSize={9.5} fontWeight={600} fill={laneVar(lane)}>
        {name}
      </text>
      {cols.map((c, i) => (
        <text key={c} x={x + 7} y={y + 30 + i * 15} fontSize={9} fill="var(--muted)">
          {c}
        </text>
      ))}
    </g>
  )
  return (
    <Frame label="Three tables, students, batches and payments, snap into an ER diagram joined by foreign keys.">
      {table(8, 10, "students", 0, ["student_name", "phone", "batch"], ["-20px", "34px", "-9deg"], 0)}
      {table(168, 10, "batches", 1, ["batch", "teacher"], ["30px", "40px", "8deg"], 120)}
      {table(88, 92, "payments", 3, ["student_name", "month"], ["-10px", "-30px", "6deg"], 240)}
      <path d="M92 52 H168" className="ld-draw" pathLength={1} fill="none" stroke={laneVar(1)} strokeWidth={1.5} style={d(1000)} />
      <path d="M50 73 V102 H88" className="ld-draw" pathLength={1} fill="none" stroke={laneVar(0)} strokeWidth={1.5} style={d(1200)} />
      <circle cx={168} cy={52} r={2.6} fill={laneVar(1)} className="ld-fade" style={d(1600)} />
      <circle cx={88} cy={102} r={2.6} fill={laneVar(0)} className="ld-fade" style={d(1800)} />
    </Frame>
  )
}

export function QueryVisual() {
  const n = (x: number, y: number, w: number, label: string, delay: number, lane?: number) => (
    <g className="ld-pop" style={d(delay)}>
      <rect
        x={x}
        y={y}
        width={w}
        height={20}
        rx={4}
        fill={lane === undefined ? "var(--raised)" : laneAlpha(lane, 0.14)}
        stroke={lane === undefined ? "var(--border-strong)" : laneAlpha(lane, 0.55)}
      />
      <text x={x + w / 2} y={y + 13.5} fontSize={9} textAnchor="middle" fill="var(--text)">
        {label}
      </text>
    </g>
  )
  return (
    <Frame label="A query plan tree grows: Hash Join over a sequential scan of payments and a hash of students.">
      {n(84, 6, 92, "Hash Join", 0)}
      <path d="M130 26 V38 H62 V50" className="ld-draw" pathLength={1} fill="none" stroke="var(--border-strong)" strokeWidth={1.25} style={d(250)} />
      <path d="M130 26 V38 H198 V50" className="ld-draw" pathLength={1} fill="none" stroke="var(--border-strong)" strokeWidth={1.25} style={d(250)} />
      {n(8, 50, 108, "Seq Scan payments", 650, 3)}
      {n(160, 50, 76, "Hash", 650)}
      <path d="M198 70 V86" className="ld-draw" pathLength={1} fill="none" stroke="var(--border-strong)" strokeWidth={1.25} style={d(950)} />
      {n(146, 86, 104, "Seq Scan students", 1250, 0)}
      <text x={8} y={134} fontSize={9} className="ld-fade" fill="var(--muted)" style={d(1600)}>
        EXPLAIN ANALYZE, timing per node
      </text>
    </Frame>
  )
}
