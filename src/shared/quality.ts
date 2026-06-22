// Agent-output reliability gate (ROADMAP M-Q). A PURE assessment of whether a
// finished run's captured output is a real, postable review. Today the runner marks
// a run `done` purely on exit code, so an agent that exits 0 with empty / truncated /
// transcript-leaked output looks successful — and, once automation can auto-post
// (M9), would publish that garbage. This flags such a run `low`, so it can be
// surfaced to the user and made INELIGIBLE for auto-post.
//
// Electron-free and in `shared/` on purpose: the renderer badge and the (future)
// main-process auto-post gate must reach the SAME verdict from the SAME function.

export type ReviewQualityLevel = 'ok' | 'low'

export interface ReviewQuality {
  level: ReviewQualityLevel
  /** Human-readable reasons when level === 'low' (empty when 'ok'). */
  reasons: string[]
}

/** The runner appends this when it caps the capture (agentRunner `MAX_CAPTURE`). */
const TRUNCATION_MARKER = 'output truncated'

/** Fewer than this many non-whitespace chars can't be a substantive review. */
const MIN_REVIEW_CHARS = 40

/**
 * High-precision signals that the captured text is a reasoning/tool-call transcript
 * (a leaked agent scratchpad) rather than a finished review. Kept deliberately narrow
 * — a false positive wrongly blocks a GOOD review, which is worse than missing a leak.
 */
function looksLikeTranscriptLeak(text: string): boolean {
  // A leaked chain-of-thought block.
  if (/<\/?thinking>/i.test(text)) return true

  // Dominated by tool-call / transcript envelope lines with no prose review. Only
  // fires when the OVERWHELMING majority of lines are obvious machine noise.
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return false
  const noise = lines.filter((l) =>
    /^\s*(●|⏺|▶|\[tool[_ ]?call\]|tool_use\b|"type"\s*:|data:\s|event:\s|functions?\.\w)/i.test(l)
  ).length
  return noise / lines.length > 0.6
}

/**
 * Assess a finished run's output. Tool runs are not human reviews (their reliability
 * is the parser's job — malformed JSON already degrades to no findings), so they are
 * never flagged here; only agent (LLM) reviews are gated.
 */
export function assessReviewQuality(
  output: string,
  opts: { kind?: 'agent' | 'tool' } = {}
): ReviewQuality {
  if (opts.kind === 'tool') return { level: 'ok', reasons: [] }

  const text = (output ?? '').trim()
  if (text === '') {
    return { level: 'low', reasons: ['The agent produced no output.'] }
  }

  const reasons: string[] = []
  if (text.includes(TRUNCATION_MARKER)) {
    reasons.push('The output was truncated before the agent finished.')
  }
  if (text.replace(/\s+/g, '').length < MIN_REVIEW_CHARS) {
    reasons.push('The output is too short to be a substantive review.')
  }
  if (looksLikeTranscriptLeak(text)) {
    reasons.push('The output looks like a tool-call/reasoning transcript, not a review.')
  }
  // The whole body is just an Aerie status/error sentinel (e.g. a missing output file).
  if (/^\[aerie\]/.test(text) && text.split('\n').filter((l) => l.trim()).length <= 2) {
    reasons.push('The run recorded an Aerie error instead of a review.')
  }

  return { level: reasons.length ? 'low' : 'ok', reasons }
}
