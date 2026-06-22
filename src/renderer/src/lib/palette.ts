// Command-palette matching (ROADMAP M14). Pure subsequence fuzzy scorer + filter, split
// from the overlay component so the ranking is unit-testable. A command's `run` is a
// callback the component invokes on Enter; the matching only reads `title`/`hint`.

export interface PaletteCommand {
  id: string
  title: string
  /** Secondary text (also searched), e.g. a repo's owner or a group name. */
  hint?: string
  /** Group label for visual sectioning (not used in scoring). */
  group?: string
  run: () => void
}

/**
 * Score how well `query` fuzzy-matches `text` (higher = better), or null if the query
 * isn't a subsequence of the text. Rewards consecutive runs and word-boundary starts, and
 * mildly prefers shorter targets. An empty query matches everything with score 0.
 */
export function scoreMatch(query: string, text: string): number | null {
  const q = query.trim().toLowerCase()
  if (q === '') return 0
  const t = text.toLowerCase()
  let score = 0
  let from = 0
  let lastIdx = -2
  let consecutive = 0
  for (const ch of q) {
    const idx = t.indexOf(ch, from)
    if (idx === -1) return null
    if (idx === lastIdx + 1) {
      consecutive += 1
      score += 5 + consecutive
    } else {
      consecutive = 0
      score += 1
    }
    if (idx === 0 || /[\s/_.-]/.test(t[idx - 1])) score += 10 // word-boundary start
    lastIdx = idx
    from = idx + 1
  }
  score -= Math.max(0, t.length - q.length) * 0.1 // mild brevity preference
  return score
}

/** Filter + rank commands for a query (best first); an empty query returns all in order. */
export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  if (query.trim() === '') return commands
  return commands
    .map((c) => ({ c, score: scoreMatch(query, `${c.title} ${c.hint ?? ''}`) }))
    .filter((x): x is { c: PaletteCommand; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c)
}
