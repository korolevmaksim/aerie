// Resolve the user's LOGIN-SHELL PATH at startup (macOS/Linux). A GUI-launched app inherits a
// truncated PATH that misses version-managed and custom tool dirs (nvm's versioned node bin,
// ~/.kimi-code/bin, ~/.mimocode/bin, …) — anything a static dir list (see osPath.ts) cannot
// predict. We spawn the user's own login+interactive shell to print its $PATH — the exact env
// their terminal sees — so tool autodiscovery matches the terminal.
//
// Bounded + safe: a hard timeout (a one-shot at app ready), NEVER throws (degrades to the static
// `augmentedPath`), and it READS $PATH only — it executes no tool. No secret is exposed: at
// startup `process.env` carries no GitHub token (tokens live in `safeStorage`, decrypted only
// transiently in the agent runner), and a unique marker isolates $PATH from any rc banner output.

import { spawnSync } from 'child_process'

const START = '__AERIE_PATH_START__'
const END = '__AERIE_PATH_END__'

/** Pure: pull the PATH string from between the markers (null if absent/empty). */
export function parseShellPath(stdout: string): string | null {
  const i = stdout.indexOf(START)
  const j = stdout.indexOf(END)
  if (i === -1 || j === -1 || j <= i) return null
  const path = stdout.slice(i + START.length, j)
  return path.length > 0 ? path : null
}

/**
 * The user's login-shell PATH, or null on Windows / failure / timeout. Runs `$SHELL -ilc` (login
 * + interactive so it sources the profile/rc where PATH is defined), printing $PATH between
 * unique markers. Synchronous one-shot, timeout-bounded, never throws.
 *
 * `fish` is intentionally not parsed: its `$PATH` is a list that quoting joins with spaces (not
 * the `:` delimiter), so it doesn't round-trip through `printf '%s'` — fish users degrade to the
 * static `augmentedPath` fallback rather than getting a garbled space-joined entry.
 */
export function loginShellPath(): string | null {
  if (process.platform === 'win32') return null
  const shell = process.env.SHELL || '/bin/zsh'
  if (/(^|\/)fish$/.test(shell)) return null
  try {
    const res = spawnSync(shell, ['-ilc', `printf '${START}%s${END}' "$PATH"`], {
      encoding: 'utf8',
      timeout: 5000,
      // stdin closed → an interactive shell hits EOF and exits after running the -c command.
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env
    })
    if (res.error || typeof res.stdout !== 'string') return null
    // Validity is the marker presence, not the exit status (some rc configs exit non-zero even
    // after printing $PATH), so parse the captured stdout regardless of `res.status`.
    return parseShellPath(res.stdout)
  } catch {
    return null
  }
}
