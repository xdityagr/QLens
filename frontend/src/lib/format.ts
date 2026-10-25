export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return "–"
  if (ms < 1000) {
    const digits = ms < 10 ? 2 : ms < 100 ? 1 : 0
    return `${ms.toFixed(digits)} ms`
  }
  const s = ms / 1000
  const digits = s < 10 ? 2 : s < 100 ? 1 : 0
  return `${s.toFixed(digits)} s`
}

const intFmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 })

export function fmtInt(n: number): string {
  return intFmt.format(Math.round(n))
}

const rel = new Intl.RelativeTimeFormat("en", { numeric: "auto" })

// "just now", "5 minutes ago", "yesterday", then a plain date after a week.
export function fmtRelative(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "never"
  const then = new Date(iso)
  const sec = Math.round((then.getTime() - now.getTime()) / 1000)
  const abs = Math.abs(sec)
  if (abs < 45) return "just now"
  if (abs < 3600) return rel.format(Math.round(sec / 60), "minute")
  if (abs < 86400) return rel.format(Math.round(sec / 3600), "hour")
  if (abs < 7 * 86400) return rel.format(Math.round(sec / 86400), "day")
  return then.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}
