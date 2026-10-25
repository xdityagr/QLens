// Starter SQL for the Data page's SQL tab, written for the user's own applied tables. Everything is read off the
// schema: the "fact" table (the one with the most foreign keys, e.g. fee_register) is joined to the tables its
// keys point at, and to the tables those point at in turn, each shown by its natural key (e.g. student_name).

export interface SnippetColumn {
  name: string
  data_type: string
  is_pk?: boolean
  fk?: { table: string; column: string } | null
}

export interface SnippetTable {
  name: string
  row_count: number | null
  columns: SnippetColumn[]
  indexes?: { columns: string[]; unique: boolean }[]
}

export interface Snippet {
  id: string
  title: string
  /** one plain sentence: what it shows, or what the database will do */
  note: string
  sql: string
  /** an INSERT/UPDATE/DELETE example, labelled as such in the UI */
  changesData: boolean
}

const NUMBER = /^(smallint|integer|bigint|numeric|real|double precision|money)\b/
const PERIOD_NAME = /(month|date|period|term|week|year|day)/i
const PERIOD_TYPE = /^(date|timestamp)/

const plain = (c: SnippetColumn) => !c.is_pk && !c.fk

/** What a row of the table is called: its single-column natural key, else its first text column. */
function labelOf(t: SnippetTable): string {
  const plainNames = new Set(t.columns.filter(plain).map((c) => c.name))
  const key = (t.indexes ?? []).find((i) => i.unique && i.columns.length === 1 && plainNames.has(i.columns[0]))
  if (key) return key.columns[0]
  return t.columns.find((c) => plain(c) && c.data_type === "text")?.name ?? "id"
}

interface Hop {
  table: SnippetTable
  alias: string
  /** the join that reaches it, e.g. "JOIN students s ON s.id = f.student_id" */
  join: string
  /** the fact table's own foreign-key column, for a direct hop */
  fkColumn: string
}

export function starterSnippets(tables: SnippetTable[]): Snippet[] {
  if (!tables.length) return []
  const byName = new Map(tables.map((t) => [t.name, t]))
  const fkCount = (t: SnippetTable) => t.columns.filter((c) => c.fk && byName.has(c.fk.table)).length
  const fact = [...tables].sort((a, b) => fkCount(b) - fkCount(a) || (b.row_count ?? 0) - (a.row_count ?? 0))[0]

  if (fkCount(fact) === 0) {
    const label = labelOf(fact)
    const out: Snippet[] = [
      {
        id: "first-rows",
        title: `First 50 rows of ${fact.name}`,
        note: "A first look at the table.",
        sql: `SELECT *\nFROM ${fact.name}\nLIMIT 50;`,
        changesData: false,
      },
    ]
    if (label !== "id")
      out.push({
        id: "rows-per",
        title: `Rows per ${label}`,
        note: `How many rows share each ${label}.`,
        sql: `SELECT ${label}, count(*) AS row_count\nFROM ${fact.name}\nGROUP BY ${label}\nORDER BY row_count DESC;`,
        changesData: false,
      })
    return out
  }

  // short aliases, unique: f, s, b ... and s2 when a letter repeats
  const taken = new Set<string>()
  const aliasFor = (name: string) => {
    const base = name[0].toLowerCase()
    let a = base
    for (let n = 2; taken.has(a); n++) a = `${base}${n}`
    taken.add(a)
    return a
  }
  const f = aliasFor(fact.name)

  const direct: Hop[] = []
  for (const c of fact.columns) {
    const ref = c.fk && byName.get(c.fk.table)
    if (!ref || ref === fact) continue
    const a = aliasFor(ref.name)
    direct.push({ table: ref, alias: a, join: `JOIN ${ref.name} ${a} ON ${a}.id = ${f}.${c.name}`, fkColumn: c.name })
  }
  // one foreign key further: fee_register → students → batches
  const seen = new Set([fact.name, ...direct.map((h) => h.table.name)])
  const second: (Hop & { via: Hop })[] = []
  for (const h of direct)
    for (const c of h.table.columns) {
      const ref = c.fk && byName.get(c.fk.table)
      if (!ref || seen.has(ref.name)) continue
      seen.add(ref.name)
      const a = aliasFor(ref.name)
      second.push({
        table: ref,
        alias: a,
        join: `JOIN ${ref.name} ${a} ON ${a}.id = ${h.alias}.${c.name}`,
        fkColumn: c.name,
        via: h,
      })
    }

  const factCols = fact.columns.filter(plain)
  const num = factCols.find((c) => NUMBER.test(c.data_type))?.name ?? null
  const periodCol =
    factCols.find((c) => c.name !== num && (PERIOD_TYPE.test(c.data_type) || PERIOD_NAME.test(c.name))) ?? null
  const period = periodCol?.name ?? null
  // A date sorts by time, so max() is the most recent. A text period ("Apr", "Sep") would sort alphabetically;
  // the newest row's value stands in for "most recent" there.
  const recent =
    periodCol && PERIOD_TYPE.test(periodCol.data_type)
      ? `(SELECT max(${period}) FROM ${fact.name})`
      : `(SELECT ${period} FROM ${fact.name} ORDER BY id DESC LIMIT 1)`
  const from = `FROM ${fact.name} ${f}`
  const dim = direct[0]
  const dimLabel = `${dim.alias}.${labelOf(dim.table)}`
  const out: Snippet[] = []

  const labels = direct.map((h) => `${h.alias}.${labelOf(h.table)}`)
  out.push({
    id: "joined",
    title: `${fact.name} with its ${direct.map((h) => h.table.name).join(" and ")}`,
    note: "Follows the foreign keys, so each row shows names instead of ids.",
    sql: [`SELECT ${f}.*, ${labels.join(", ")}`, from, ...direct.map((h) => h.join), "LIMIT 50;"].join("\n"),
    changesData: false,
  })

  // per group: the furthest table if there is one (per batch), else the direct one (per student)
  const far = second[0] as (Hop & { via: Hop }) | undefined
  const group: Hop = far ?? dim
  const groupLabel = `${group.alias}.${labelOf(group.table)}`
  const groupJoins = far ? [far.via.join, far.join] : [dim.join]
  const groupName = labelOf(group.table) === "id" ? group.table.name : labelOf(group.table)
  out.push({
    id: "per-group",
    title: num ? `Total ${num} per ${groupName}` : `${fact.name} rows per ${groupName}`,
    note: `Groups ${fact.name} by ${group.table.name}, joining through the foreign keys.`,
    sql: [
      `SELECT ${groupLabel}, count(*) AS ${fact.name}_rows${num ? `, sum(${f}.${num}) AS total_${num}` : ""}`,
      from,
      ...groupJoins,
      `GROUP BY ${groupLabel}`,
      `ORDER BY ${num ? `total_${num}` : `${fact.name}_rows`} DESC;`,
    ].join("\n"),
    changesData: false,
  })

  if (num)
    out.push({
      id: "top",
      title: `Top 10 ${dim.table.name} by ${num}`,
      note: `Adds up ${num} for each of the ${dim.table.name} and keeps the ten largest.`,
      sql: [
        `SELECT ${dimLabel}, sum(${f}.${num}) AS total_${num}`,
        from,
        dim.join,
        `GROUP BY ${dim.alias}.id, ${dimLabel}`,
        `ORDER BY total_${num} DESC`,
        "LIMIT 10;",
      ].join("\n"),
      changesData: false,
    })

  if (num && period)
    out.push({
      id: "zero-latest",
      title: `${dim.table.name} with ${num} = 0 in the most recent ${period}`,
      note: `Rows where ${num} is 0, for the ${period} of the ${recent.includes("max(") ? "latest date" : "newest row"}.`,
      sql: [
        `SELECT ${dimLabel}, ${f}.${period}, ${f}.${num}`,
        from,
        dim.join,
        `WHERE ${f}.${num} = 0`,
        `  AND ${f}.${period} = ${recent}`,
        `ORDER BY ${dimLabel};`,
      ].join("\n"),
      changesData: false,
    })

  out.push({
    id: "never",
    title: `${dim.table.name} with no ${fact.name} rows`,
    note: `NOT EXISTS keeps the ${dim.table.name} that no ${fact.name} row points at.`,
    sql: [
      `SELECT ${dim.alias}.*`,
      `FROM ${dim.table.name} ${dim.alias}`,
      `WHERE NOT EXISTS (SELECT 1 FROM ${fact.name} ${f} WHERE ${f}.${dim.fkColumn} = ${dim.alias}.id);`,
    ].join("\n"),
    changesData: false,
  })

  if (num)
    out.push({
      id: "update-one",
      title: `Add 100 to ${num} of one ${fact.name} row`,
      note: "Changes one row. The audit trigger records it, and Browse shows it under recent changes.",
      sql: `UPDATE ${fact.name}\nSET ${num} = ${num} + 100\nWHERE id = (SELECT min(id) FROM ${fact.name});`,
      changesData: true,
    })

  out.push({
    id: "refused-delete",
    title: `Try to delete a ${singular(dim.table.name)} that ${fact.name} uses`,
    note: "The foreign key refuses it (ON DELETE RESTRICT), so nothing is deleted.",
    sql: `DELETE FROM ${dim.table.name}\nWHERE id = (SELECT min(${dim.fkColumn}) FROM ${fact.name});`,
    changesData: true,
  })
  return out
}

function singular(name: string): string {
  if (name.endsWith("ies")) return name.slice(0, -3) + "y"
  if (/(ches|shes|sses|xes)$/.test(name)) return name.slice(0, -2)
  if (name.endsWith("s") && !name.endsWith("ss")) return name.slice(0, -1)
  return name
}
