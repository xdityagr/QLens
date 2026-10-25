// A small markdown reader for the assistant's replies. It produces a tree that React renders as
// text nodes, so nothing in a reply is ever treated as HTML. Covered: paragraphs, headings, lists,
// fenced code, pipe tables, `code`, **bold**, *italic*, and http(s) links.

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "b"; c: Inline[] }
  | { t: "i"; c: Inline[] }
  | { t: "a"; href: string; c: Inline[] }

export type Block =
  | { type: "p"; inlines: Inline[] }
  | { type: "h"; level: number; inlines: Inline[] }
  | { type: "ul" | "ol"; items: Inline[][] }
  | { type: "code"; lang: string; text: string }
  | { type: "table"; head: Inline[][]; rows: Inline[][][] }

const LINK = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/
const word = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_]/u.test(c)

export function parseInline(s: string): Inline[] {
  const out: Inline[] = []
  let buf = ""
  const flush = () => {
    if (buf) out.push({ t: "text", v: buf })
    buf = ""
  }
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === "`") {
      const j = s.indexOf("`", i + 1)
      if (j > i + 1) {
        flush()
        out.push({ t: "code", v: s.slice(i + 1, j) })
        i = j + 1
        continue
      }
    }
    if (s.startsWith("**", i)) {
      const j = s.indexOf("**", i + 2)
      if (j > i + 2 && s[i + 2] !== " ") {
        flush()
        out.push({ t: "b", c: parseInline(s.slice(i + 2, j)) })
        i = j + 2
        continue
      }
    }
    if ((ch === "*" || ch === "_") && s[i + 1] !== undefined && s[i + 1] !== " " && s[i + 1] !== ch) {
      // `_` only at a word edge, so snake_case identifiers stay as they are
      if (ch === "*" || !word(s[i - 1])) {
        let j = i + 1
        let close = -1
        while ((j = s.indexOf(ch, j)) !== -1) {
          if (s[j - 1] !== " " && s[j + 1] !== ch && (ch === "*" || !word(s[j + 1]))) {
            close = j
            break
          }
          j++
        }
        if (close > i + 1) {
          flush()
          out.push({ t: "i", c: parseInline(s.slice(i + 1, close)) })
          i = close + 1
          continue
        }
      }
    }
    if (ch === "[") {
      const m = LINK.exec(s.slice(i))
      if (m) {
        flush()
        out.push({ t: "a", href: m[2], c: parseInline(m[1]) })
        i += m[0].length
        continue
      }
    }
    buf += ch
    i++
  }
  flush()
  return out
}

const FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const isRow = (l: string) => l.trim().startsWith("|")

function cells(line: string): Inline[][] {
  let t = line.trim()
  if (t.startsWith("|")) t = t.slice(1)
  if (t.endsWith("|")) t = t.slice(0, -1)
  return t.split("|").map((c) => parseInline(c.trim()))
}

const startsBlock = (line: string, next: string | undefined) =>
  FENCE.test(line) ||
  HEADING.test(line) ||
  BULLET.test(line) ||
  NUMBERED.test(line) ||
  (isRow(line) && next !== undefined && TABLE_SEP.test(next))

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n")
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++])
      i++ // closing fence (or past the end)
      out.push({ type: "code", lang: fence[2].toLowerCase(), text: body.join("\n") })
      continue
    }
    const h = HEADING.exec(line)
    if (h) {
      out.push({ type: "h", level: h[1].length, inlines: parseInline(h[2]) })
      i++
      continue
    }
    if (isRow(line) && lines[i + 1] !== undefined && TABLE_SEP.test(lines[i + 1])) {
      const head = cells(line)
      i += 2
      const rows: Inline[][][] = []
      while (i < lines.length && isRow(lines[i])) rows.push(cells(lines[i++]))
      out.push({ type: "table", head, rows })
      continue
    }
    const kind = BULLET.test(line) ? "ul" : NUMBERED.test(line) ? "ol" : null
    if (kind) {
      const re = kind === "ul" ? BULLET : NUMBERED
      const raw: string[] = []
      while (i < lines.length) {
        const m = re.exec(lines[i])
        if (m) raw.push(m[1].trim())
        else if (/^\s{2,}\S/.test(lines[i]) && raw.length) raw[raw.length - 1] += " " + lines[i].trim()
        else break
        i++
      }
      out.push({ type: kind, items: raw.map(parseInline) })
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines[i], lines[i + 1])))
      para.push(lines[i++].trim())
    out.push({ type: "p", inlines: parseInline(para.join(" ")) })
  }
  return out
}
