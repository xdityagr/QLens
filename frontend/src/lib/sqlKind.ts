// What kind of statement the SQL tab is about to run, for the UI only: which button, which confirm card.
// The server decides what may run (validate_select / validate_write); a wrong guess here only means the
// server refuses the statement with its own message.

export type StatementKind = "select" | "insert" | "update" | "delete" | "other" | "empty"

export interface StatementInfo {
  kind: StatementKind
  /** the table an INSERT, UPDATE or DELETE changes, as written (schema prefix dropped) */
  table: string | null
  /** an UPDATE or DELETE with a WHERE at the top level; false means every row of the table */
  hasWhere: boolean
  /** the first keyword, upper-cased (e.g. "TRUNCATE"), for messages about other statements */
  keyword: string | null
}

interface Token {
  /** a word upper-cased, an identifier as written (quotes removed), or one punctuation character */
  text: string
  word: boolean
  depth: number
}

/** Words and punctuation outside strings and comments, each with its parenthesis depth. */
function tokens(sql: string): Token[] {
  const out: Token[] = []
  let depth = 0
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    const next = sql[i + 1]
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i)
      i = end === -1 ? sql.length : end + 1
    } else if (c === "/" && next === "*") {
      let level = 1
      i += 2
      while (i < sql.length && level > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          level++
          i += 2
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          level--
          i += 2
        } else i++
      }
    } else if (c === "'") {
      i++
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2
        else if (sql[i] === "'") break
        else i++
      }
      i++
      out.push({ text: "'", word: false, depth })
    } else if (c === '"') {
      const end = sql.indexOf('"', i + 1)
      const stop = end === -1 ? sql.length : end
      out.push({ text: sql.slice(i + 1, stop), word: false, depth })
      i = stop + 1
    } else if (c === "$" && /^\$[A-Za-z_]*\$/.test(sql.slice(i))) {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))![0]
      const end = sql.indexOf(tag, i + tag.length)
      i = end === -1 ? sql.length : end + tag.length
      out.push({ text: "'", word: false, depth })
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j])) j++
      out.push({ text: sql.slice(i, j).toUpperCase(), word: true, depth })
      i = j
    } else if (c === "(") {
      out.push({ text: c, word: false, depth })
      depth++
      i++
    } else if (c === ")") {
      depth = Math.max(0, depth - 1)
      out.push({ text: c, word: false, depth })
      i++
    } else if (/\s/.test(c)) {
      i++
    } else {
      out.push({ text: c, word: false, depth })
      i++
    }
  }
  return out
}

const MAIN = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "VALUES", "TABLE", "MERGE"])

export function statementInfo(sql: string): StatementInfo {
  const ts = tokens(sql)
  // a trailing semicolon (and anything after it) is not part of the statement's kind
  const stop = ts.findIndex((t) => t.text === ";" && t.depth === 0)
  const body = stop === -1 ? ts : ts.slice(0, stop)
  if (!body.length) return { kind: "empty", table: null, hasWhere: false, keyword: null }
  const first = body.find((t) => t.text !== "(")
  const keyword = first?.word ? first.text : null
  let at = body.indexOf(first!)
  if (keyword === "WITH") {
    // after the CTEs, the first main keyword back at the top level is the statement
    at = body.findIndex((t, i) => i > at && t.depth === 0 && t.word && MAIN.has(t.text))
    if (at === -1) return { kind: "other", table: null, hasWhere: false, keyword }
  }
  const head = body[at]
  if (!head?.word) return { kind: "other", table: null, hasWhere: false, keyword }
  const top = head.depth
  const whereAfter = (i: number) => body.some((t, k) => k > i && t.depth === top && t.word && t.text === "WHERE")
  switch (head.text) {
    case "SELECT":
    case "VALUES":
    case "TABLE":
      return { kind: "select", table: null, hasWhere: false, keyword: head.text }
    case "INSERT": {
      const into = body[at + 1]?.text === "INTO" ? at + 2 : at + 1
      return { kind: "insert", table: tableName(body, into), hasWhere: false, keyword: "INSERT" }
    }
    case "UPDATE":
      return { kind: "update", table: tableName(body, at + 1), hasWhere: whereAfter(at), keyword: "UPDATE" }
    case "DELETE": {
      const from = body[at + 1]?.text === "FROM" ? at + 2 : at + 1
      return { kind: "delete", table: tableName(body, from), hasWhere: whereAfter(at), keyword: "DELETE" }
    }
    default:
      return { kind: "other", table: null, hasWhere: false, keyword: keyword ?? head.text }
  }
}

/** schema.table or table at body[i] (after an optional ONLY); the table part, lower-cased unless it was quoted. */
function tableName(body: Token[], i: number): string | null {
  let k = i
  if (body[k]?.word && body[k].text === "ONLY") k++
  const first = body[k]
  if (!first || first.text === "(" || first.text === "'") return null
  let last = first
  while (body[k + 1]?.text === "." && body[k + 2]) {
    last = body[k + 2]
    k += 2
  }
  return last.word ? last.text.toLowerCase() : last.text
}

export const isWrite = (k: StatementKind) => k === "insert" || k === "update" || k === "delete"

/** "This will UPDATE rows in fee_register." */
export function writeSummary(info: StatementInfo): string {
  const t = info.table ?? "a table"
  switch (info.kind) {
    case "insert":
      return `This will INSERT rows into ${t}.`
    case "update":
      return `This will UPDATE rows in ${t}.`
    case "delete":
      return `This will DELETE rows from ${t}.`
    default:
      return ""
  }
}
