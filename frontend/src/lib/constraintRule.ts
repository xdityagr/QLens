// The heading of a refused write on the Data screen: which kind of rule fired, and which one.

const RULE: Record<string, string> = {
  unique: "UNIQUE",
  foreign_key: "FOREIGN KEY",
  not_null: "NOT NULL",
  check: "CHECK",
  invalid_input: "TYPE",
}

export function constraintRule(d: { kind: string; constraint: string | null; columns: string[]; table: string }): {
  rule: string
  name: string
} {
  const name = d.constraint ?? (d.columns.length ? `${d.table}.${d.columns.join(", ")}` : d.table)
  return { rule: RULE[d.kind] ?? "CONSTRAINT", name }
}
