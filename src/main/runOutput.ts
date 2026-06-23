// Pure helpers for finalizing agent run output (electron-free → unit-tested).
//
// A `file`-capture agent is expected to write its review to a declared output file. If it exits
// without producing that file — most often because the agent's own CLI failed to start (a bad
// config, missing auth, wrong flag) — the runner used to report only a bare "declared output file
// not found", discarding the agent's actual stderr/stdout where the real cause was printed. These
// helpers retain a bounded tail of that output and fold it into an actionable error message.

/** Max chars of agent stdout/stderr kept for diagnostics — a CLI's fatal error sits just before exit. */
export const DIAG_TAIL_MAX = 4096

/** Append `chunk` to `buffer`, keeping only the last `max` chars (the tail). */
export function keepTail(buffer: string, chunk: string, max: number = DIAG_TAIL_MAX): string {
  const next = buffer + chunk
  return next.length > max ? next.slice(next.length - max) : next
}

/**
 * Compose an actionable error for a `file`-capture agent that exited without writing its declared
 * output file. Includes the exit code (0 here means the agent "succeeded" yet wrote nothing — a
 * contract/config mismatch) and the tail of what the agent actually printed, so the failure is
 * self-explanatory (e.g. a CLI config error) instead of a generic not-found. The caller scrubs
 * secrets from the returned string before it is persisted or shown.
 */
export function formatMissingOutputError(
  exitCode: number | null,
  reason: string,
  diagTail: string
): string {
  const head = `[aerie] agent exited (code ${exitCode ?? 'null'}) without producing its declared output file — ${reason}.`
  const tail = diagTail.trim()
  return tail ? `${head}\n\n--- last agent output ---\n${tail}` : head
}
