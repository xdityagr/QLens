import { Calendar, Hash, ToggleLeft, Type, type LucideIcon } from "lucide-react"
import type { InferredType } from "./types"

/** How an inferred SQL type is shown: neutral, since lane colours mean tables. */
export const TYPE_META: Record<InferredType, { label: string; icon: LucideIcon }> = {
  integer: { label: "integer", icon: Hash },
  numeric: { label: "numeric", icon: Hash },
  date: { label: "date", icon: Calendar },
  boolean: { label: "boolean", icon: ToggleLeft },
  text: { label: "text", icon: Type },
}
