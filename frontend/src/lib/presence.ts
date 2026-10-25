/** An item as rendered: `leaving` items are gone from the data but kept briefly to animate out. */
export interface Present<T> {
  key: string
  item: T
  leaving: boolean
}

/**
 * Merge what is on screen with the next list: new and kept items take the next list's order and
 * values; removed items stay where they were (after the item they used to follow) marked leaving.
 */
export function reconcilePresence<T>(prev: Present<T>[], next: T[], keyOf: (t: T) => string): Present<T>[] {
  const out: Present<T>[] = next.map((item) => ({ key: keyOf(item), item, leaving: false }))
  const live = new Set(out.map((p) => p.key))
  prev.forEach((p, i) => {
    if (live.has(p.key)) return
    // the closest earlier item that is still on screen anchors the leaving one
    let at = 0
    for (let j = i - 1; j >= 0; j--) {
      const idx = out.findIndex((o) => o.key === prev[j].key)
      if (idx >= 0) {
        at = idx + 1
        break
      }
    }
    out.splice(at, 0, { ...p, leaving: true })
  })
  return out
}
