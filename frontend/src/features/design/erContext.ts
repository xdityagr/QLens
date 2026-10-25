import { createContext, useContext } from "react"

export type RenameTarget = { kind: "table" | "column"; id: number }

/**
 * What table nodes and edges need from the page, kept out of node data so React Flow nodes stay
 * plain layout (layoutEr's output) and a hover doesn't rebuild every node.
 */
export interface ErContextValue {
  /** renames are allowed only on a draft */
  editable: boolean
  /** resolves when saved; rejects with an ApiError whose message is shown inline */
  rename: (target: RenameTarget, name: string) => Promise<void>
  /** table id under the pointer, in the diagram or the side panel */
  hovered: number | null
  setHovered: (id: number | null) => void
  /** tables joined to the hovered one by a foreign key (either way) */
  related: Set<number> | null
  /** live row counts by table name, once the design is applied */
  rowCounts: Map<string, number> | null
  /** table id -> lane colour index, for fk icons */
  laneOf: Map<number, number>
}

export const ErContext = createContext<ErContextValue | null>(null)

export function useEr(): ErContextValue {
  const v = useContext(ErContext)
  if (!v) throw new Error("ErContext missing")
  return v
}
