// Pure PATH lookup — the electron-free core of agent/tool autodiscovery. Kept
// here (not in agentRunner, which imports electron) so it is unit-testable and so
// the broad detection catalog (ROADMAP M1b) has a single seam to build on.

import { existsSync, statSync } from 'fs'
import { delimiter, join } from 'path'

/** True if the path exists and is a regular file (not a directory). */
function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

/** On Windows, the executable name variants to try for a bare command. */
function windowsNames(bin: string, env: NodeJS.ProcessEnv): string[] {
  if (/\.[^./\\]+$/.test(bin)) return [bin] // already has an extension
  const exts = (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
  return [bin, ...exts.map((ext) => bin + ext.toLowerCase())]
}

/**
 * Resolves a binary to an absolute path if found, else null.
 * - An explicit path (contains a separator) is checked as-is.
 * - A bare name is searched across the entries of `env.PATH`.
 * Only a regular FILE counts as a match (a same-named directory does not). On
 * Windows, bare names also try the PATHEXT suffixes (.exe/.cmd/.bat/.com).
 */
export function whichOnPath(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (!bin) return null
  if (bin.includes('/') || bin.includes('\\')) return isFile(bin) ? bin : null
  const names = platform === 'win32' ? windowsNames(bin, env) : [bin]
  const dirs = (env.PATH ?? '').split(delimiter)
  for (const dir of dirs) {
    if (!dir) continue
    for (const name of names) {
      const full = join(dir, name)
      if (isFile(full)) return full
    }
  }
  return null
}

/** Convenience boolean wrapper used by availability checks. */
export function isOnPath(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  return whichOnPath(bin, env, platform) !== null
}
