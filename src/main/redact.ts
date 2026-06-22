// GitHub token patterns: classic (ghp_/gho_/ghs_/ghu_) and fine-grained
// (github_pat_). Used to scrub tokens from logs (electron-free for testability).
const TOKEN_RE = /\b(gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g

/** Recursively replaces any GitHub-token-looking string with [REDACTED]. */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(TOKEN_RE, '[REDACTED]')
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = redact(v)
    return out
  }
  return value
}

/**
 * Scrubs a block of text before it is written to disk or posted: GitHub tokens are
 * always replaced, plus any provided literal secret strings (e.g. values a gitleaks
 * scan surfaced in a tool run). Literal secrets are matched verbatim (no regex), and
 * very short ones (<8 chars) are deliberately ignored to avoid over-redacting
 * incidental text — a conscious trade-off, so a sub-8-char secret would remain.
 */
export function redactText(text: string, extraSecrets: string[] = []): string {
  let out = text.replace(TOKEN_RE, '[REDACTED]')
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join('[REDACTED]')
  }
  return out
}
