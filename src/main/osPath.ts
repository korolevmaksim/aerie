// Pure PATH augmentation — fixes the macOS "GUI launch" problem where an app
// started from Finder/launchd inherits a truncated PATH (often just
// /usr/bin:/bin:/usr/sbin:/sbin), so tools installed via Homebrew, cargo, npm,
// bun, pipx, etc. read as "not installed". We append the well-known per-user and
// per-manager install dirs that exist and aren't already present, so tool
// autodiscovery sees them. Electron-free + unit-testable.

import { delimiter, join } from 'path'

/** Candidate install dirs by platform, given the user's home dir. */
function candidateDirs(platform: NodeJS.Platform, home: string): string[] {
  if (platform === 'win32') return [] // Windows GUI launch keeps the full PATH.
  const system = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ]
  const user = home
    ? [
        join(home, '.local/bin'),
        join(home, 'bin'),
        join(home, '.cargo/bin'),
        join(home, '.bun/bin'),
        join(home, '.deno/bin'),
        join(home, 'go/bin'),
        join(home, '.npm-global/bin'),
        join(home, '.volta/bin'),
        join(home, '.asdf/shims'),
        join(home, '.rye/shims')
      ]
    : []
  return [...system, ...user]
}

/**
 * Returns PATH with any missing well-known install dirs appended — existing
 * entries keep precedence, so this only fills gaps (it never reorders or shadows
 * what already resolves). `exists` is injected for testability. On Windows the
 * input is returned unchanged.
 */
export function augmentedPath(
  currentPath: string,
  opts: { home: string; platform: NodeJS.Platform; exists: (p: string) => boolean }
): string {
  if (opts.platform === 'win32') return currentPath
  const present = new Set(currentPath.split(delimiter).filter(Boolean))
  const additions = candidateDirs(opts.platform, opts.home).filter(
    (dir) => !present.has(dir) && opts.exists(dir)
  )
  if (additions.length === 0) return currentPath
  const base = currentPath ? [currentPath] : []
  return [...base, ...additions].join(delimiter)
}

/**
 * Merges several PATH strings (in priority order) into one: splits each on the platform path
 * delimiter and keeps the FIRST occurrence of every non-empty dir, preserving order. Used to
 * fold the resolved login-shell PATH together with the static `augmentedPath` fallback. Pure.
 */
export function mergePaths(...lists: string[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const dir of list.split(delimiter)) {
      if (dir && !seen.has(dir)) {
        seen.add(dir)
        out.push(dir)
      }
    }
  }
  return out.join(delimiter)
}
