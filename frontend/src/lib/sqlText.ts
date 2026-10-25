export interface ErrorLocation {
  /** 0-based offset into the editor text */
  offset: number
  line: number
  column: number
  lineText: string
}

/**
 * Where an error position (1-based, PostgreSQL's convention) falls in the text the user typed.
 * The server trims the statement before running it, so database positions count from the first
 * non-blank character; validation positions count from the original text.
 */
export function locateError(sql: string, code: string, position: number | null | undefined): ErrorLocation | null {
  if (position === null || position === undefined || !Number.isFinite(position) || position < 1) return null
  const shift = code === "db_error" ? sql.length - sql.trimStart().length : 0
  const offset = Math.min(sql.length, shift + position - 1)
  const before = sql.slice(0, offset)
  const lineStart = before.lastIndexOf("\n") + 1
  const lineEnd = sql.indexOf("\n", offset)
  return {
    offset,
    line: before.split("\n").length,
    column: offset - lineStart + 1,
    lineText: sql.slice(lineStart, lineEnd === -1 ? undefined : lineEnd),
  }
}

// Keywords that end a FROM list or a join's table reference.
const LEAVE_FROM = new Set([
  "where",
  "group",
  "order",
  "limit",
  "having",
  "window",
  "union",
  "intersect",
  "except",
  "offset",
  "fetch",
  "on",
  "using",
  "select",
  "returning",
  "for",
])

/**
 * Which of `tables` a query reads, in order of first mention: names that appear in a FROM list or
 * after JOIN, ignoring strings and comments. A reading aid for lane colours, not a parser.
 */
export function tablesInSql(sql: string, tables: string[]): string[] {
  const known = new Map(tables.map((t) => [t.toLowerCase(), t]))
  const clean = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
  const tokens = clean.match(/"(?:[^"]|"")+"|[A-Za-z_][\w$]*|[(),.;]/g) ?? []
  const found: string[] = []
  let inFrom = false
  let depth = 0
  const fromDepth: number[] = []
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i]
    const tok = raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw.toLowerCase()
    if (raw === "(") {
      depth++
      continue
    }
    if (raw === ")") {
      depth--
      // closing a subquery puts us back in the FROM list it sat in
      inFrom = fromDepth.length > 0 && fromDepth[fromDepth.length - 1] === depth
      if (inFrom) fromDepth.pop()
      continue
    }
    if (!raw.startsWith('"') && (tok === "from" || tok === "join")) {
      inFrom = true
      continue
    }
    if (!raw.startsWith('"') && LEAVE_FROM.has(tok)) {
      if (tok === "select" && inFrom) fromDepth.push(depth - 1)
      inFrom = false
      continue
    }
    if (!inFrom) continue
    // schema-qualified: the table is the part after the dot
    if (tokens[i + 1] === ".") continue
    const name = known.get(raw.startsWith('"') ? tok.toLowerCase() : tok)
    // only a table reference sits right after FROM/JOIN/comma/dot, not an alias
    const prev = tokens[i - 1]?.toLowerCase()
    const isRef =
      prev === "from" || prev === "join" || prev === "," || prev === "." || prev === "only" || prev === "lateral"
    if (name && isRef && !found.includes(name)) found.push(name)
  }
  return found
}
