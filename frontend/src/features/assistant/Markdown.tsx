import { useMemo, type ReactNode } from "react"
import { laneAlpha, laneVar } from "../../lib/lanes"
import { isSqlBlock, parseMarkdown, type Block, type Inline } from "./mdParse"

/** Table name -> its lane, so `students` in a reply wears the students colour. */
export type LaneOf = (name: string) => number | null

/**
 * Renders a reply from the parsed tree: every piece of text is a React text node, so a reply can't
 * inject markup. SQL code blocks get the screen's actions (copy, open in Query, insert into editor).
 */
export function Markdown({
  text,
  laneOf,
  renderSql,
}: {
  text: string
  laneOf: LaneOf
  /** `index` counts SQL blocks only, in order (attachRuns pairs runs in the same order) */
  renderSql: (sql: string, key: number, index: number) => ReactNode
}) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  let sqlIndex = 0
  return (
    <div className="as-prose">
      {blocks.map((b, i) => (isSqlBlock(b) ? renderSql(b.text, i, sqlIndex++) : renderBlock(b, i, laneOf)))}
    </div>
  )
}

function renderBlock(b: Block, key: number, laneOf: LaneOf) {
  switch (b.type) {
    case "p":
      return <p key={key}>{inlines(b.inlines, laneOf)}</p>
    case "h":
      return (
        <p key={key} className="font-semibold tracking-[-0.01em] text-text">
          {inlines(b.inlines, laneOf)}
        </p>
      )
    case "ul":
    case "ol": {
      const List = b.type
      return (
        <List key={key}>
          {b.items.map((item, i) => (
            <li key={i}>{inlines(item, laneOf)}</li>
          ))}
        </List>
      )
    }
    case "code":
      return (
        <pre
          key={key}
          className="scrollbar-thin overflow-x-auto rounded-control border border-border bg-surface p-3 font-mono text-[12px] leading-[1.6]"
        >
          <code>{b.text}</code>
        </pre>
      )
    case "table":
      return (
        <div key={key} className="scrollbar-thin overflow-x-auto rounded-control border border-border">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr>
                {b.head.map((c, i) => (
                  <th key={i} className="border-b border-border bg-raised px-2.5 py-1.5 text-left font-medium">
                    {inlines(c, laneOf)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} className="border-b border-border px-2.5 py-1.5 align-top last:border-b-0">
                      {inlines(c, laneOf)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}

function inlines(list: Inline[], laneOf: LaneOf): ReactNode[] {
  return list.map((n, i) => {
    switch (n.t) {
      case "text":
        return n.v
      case "b":
        return (
          <strong key={i} className="font-semibold">
            {inlines(n.c, laneOf)}
          </strong>
        )
      case "i":
        return <em key={i}>{inlines(n.c, laneOf)}</em>
      case "a":
        return (
          <a key={i} href={n.href} target="_blank" rel="noreferrer noopener">
            {inlines(n.c, laneOf)}
          </a>
        )
      case "code": {
        // `students` or `students.batch_id`: the table part decides the lane
        const lane = laneOf(n.v.split(".")[0])
        return (
          <code
            key={i}
            className="as-code"
            style={lane === null ? undefined : { color: laneVar(lane), background: laneAlpha(lane, 0.12) }}
          >
            {n.v}
          </code>
        )
      }
    }
  })
}
