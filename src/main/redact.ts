// Known secret/token patterns scrubbed from any run output before it is persisted,
// streamed to the UI, or posted to GitHub (electron-free for testability). Aerie shells
// out to third-party coding agents that authenticate with their OWN provider keys, so an
// agent's verbose output or auth error can print a non-GitHub secret — cover the common
// shapes, not just GitHub. Each alternative is prefix-anchored and length-bounded (and the
// dash-prefixed ones are `\b`-guarded so `task-`/`risk-`/`disk-` can't masquerade as `sk-`)
// to keep false positives near zero; over-matching a token-shaped string in review output
// is the safe direction (we would rather redact than post a key).
const SECRET_RE = new RegExp(
  [
    '\\bgh[opsu]_[A-Za-z0-9]{20,}\\b', // GitHub classic (ghp_/gho_/ghs_/ghu_)
    '\\bgithub_pat_[A-Za-z0-9_]{20,}\\b', // GitHub fine-grained PAT
    '\\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}', // OpenAI / Anthropic API keys
    '\\bAKIA[0-9A-Z]{16}\\b', // AWS access key id
    '\\bAIza[0-9A-Za-z_-]{35}', // Google API key (no trailing \b: the body may end in '-')
    '\\bxox[baprs]-[A-Za-z0-9-]{10,}', // Slack token
    '(?<=:\\/\\/)[^/\\s:@]+:[^/\\s@]+(?=@)', // credentials in a URL authority (user:pass@) e.g. a git remote with an embedded PAT
    '-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----' // PEM private key block
  ].join('|'),
  'g'
)

/** Recursively replaces any known-secret-looking string with [REDACTED]. */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(SECRET_RE, '[REDACTED]')
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = redact(v)
    return out
  }
  return value
}

/**
 * Scrubs a block of text before it is written to disk, streamed, or posted: known secret
 * shapes (GitHub tokens, OpenAI/Anthropic/AWS/Google/Slack keys, PEM private-key blocks) are
 * always replaced, plus any provided literal secret strings (e.g. values a gitleaks scan
 * surfaced in a tool run). Literal secrets are matched verbatim (no regex), and very short
 * ones (<8 chars) are deliberately ignored to avoid over-redacting incidental text — a
 * conscious trade-off, so a sub-8-char secret would remain.
 */
export function redactText(text: string, extraSecrets: string[] = []): string {
  let out = text.replace(SECRET_RE, '[REDACTED]')
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join('[REDACTED]')
  }
  return out
}
