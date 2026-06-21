// Input validators shared across IPC handlers. Pure + electron-free (testable).

/** A positive integer row id. */
export function isValidId(id: unknown): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id > 0
}

const SHA_RE = /^[0-9a-f]{7,40}$/i

/** A hex commit SHA (abbreviated 7 chars up to full 40). */
export function isValidSha(sha: unknown): sha is string {
  return typeof sha === 'string' && SHA_RE.test(sha)
}
