// Pure PATH lookup — the electron-free core of agent/tool autodiscovery. Kept
// here (not in agentRunner, which imports electron) so it is unit-testable and so
// the broad detection catalog (ROADMAP M1) has a single seam to build on.

import { existsSync } from 'fs'
import { delimiter, join } from 'path'

/**
 * Resolves a binary to an absolute path if it is found, else null.
 * - An explicit path (contains a separator) is checked as-is.
 * - A bare name is searched across the entries of `env.PATH`.
 *
 * No platform-specific suffix handling yet (Windows .exe/.cmd is ROADMAP M1);
 * this preserves the previous `isInstalled` behavior exactly while making it
 * reusable and testable.
 */
export function whichOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!bin) return null
  if (bin.includes('/') || bin.includes('\\')) return existsSync(bin) ? bin : null
  const dirs = (env.PATH ?? '').split(delimiter)
  for (const dir of dirs) {
    if (!dir) continue
    const full = join(dir, bin)
    if (existsSync(full)) return full
  }
  return null
}

/** Convenience boolean wrapper used by availability checks. */
export function isOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return whichOnPath(bin, env) !== null
}
