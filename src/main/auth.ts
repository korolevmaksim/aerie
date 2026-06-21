import { safeStorage } from 'electron'
import type { AccountKind, RateLimitInfo } from '../shared/types'
import { log } from './logger'

/**
 * Token handling and GitHub identity/rate-limit validation. Main process only.
 * Tokens are encrypted at rest with Electron `safeStorage` (OS keychain) and
 * are NEVER returned to the renderer or written to a log (SPEC §4).
 */

export interface ValidatedIdentity {
  login: string
  kind: AccountKind
  rateLimit: RateLimitInfo
}

function assertEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS secure storage is unavailable, so the token cannot be encrypted at rest. ' +
        'On Linux this needs an available keyring (e.g. gnome-keyring/kwallet).'
    )
  }
}

/** Encrypts a token for at-rest storage. */
export function encryptToken(token: string): Buffer {
  assertEncryptionAvailable()
  return safeStorage.encryptString(token)
}

/** Decrypts a stored token blob for use in a GitHub request. */
export function decryptToken(blob: Buffer): string {
  assertEncryptionAvailable()
  return safeStorage.decryptString(blob)
}

/**
 * Builds an Octokit client for a token, with automatic rate-limit/secondary-limit
 * backoff (throttling) and transient-error retry (SPEC §7). Octokit is ESM-only,
 * so it (and the plugins) load via dynamic import from the CommonJS main bundle.
 */
export async function createOctokit(
  token: string
): Promise<InstanceType<typeof import('@octokit/rest').Octokit>> {
  const [{ Octokit }, { throttling }, { retry }] = await Promise.all([
    import('@octokit/rest'),
    import('@octokit/plugin-throttling'),
    import('@octokit/plugin-retry')
  ])
  const AerieOctokit = Octokit.plugin(throttling, retry)
  return new AerieOctokit({
    auth: token,
    userAgent: 'Aerie',
    throttle: {
      onRateLimit: (retryAfter, options, _octokit, retryCount) => {
        log.warn('GitHub rate limit hit', { method: options.method, url: options.url, retryAfter })
        return retryCount < 2 // retry twice, then give up
      },
      onSecondaryRateLimit: (_retryAfter, options) => {
        log.warn('GitHub secondary rate limit hit', { method: options.method, url: options.url })
        return true
      }
    }
  })
}

/**
 * Validates a token against GitHub: confirms identity (`users.getAuthenticated`)
 * and reads the current rate limit (`rateLimit.get`).
 */
export async function validateToken(token: string): Promise<ValidatedIdentity> {
  const octokit = await createOctokit(token)

  const { data: me } = await octokit.rest.users.getAuthenticated()
  const { data: rate } = await octokit.rest.rateLimit.get()

  return {
    login: me.login,
    kind: me.type === 'Organization' ? 'org' : 'user',
    rateLimit: {
      limit: rate.rate.limit,
      remaining: rate.rate.remaining,
      reset: rate.rate.reset
    }
  }
}

/**
 * Normalizes a GitHub/Octokit error into a renderer-safe message. Maps the
 * common auth failures to something actionable and returns a GENERIC message for
 * anything else — the raw Octokit error can carry request details (and its
 * headers carry the token), so it must never be forwarded to the renderer or a
 * log.
 */
export function describeAuthError(error: unknown): string {
  const status = (error as { status?: number } | undefined)?.status
  if (status === 401) return 'GitHub rejected the token (401). Check it is valid and not expired.'
  if (status === 403) return 'GitHub returned 403 — token may lack scopes or be rate-limited.'
  if (status === 404) return 'GitHub returned 404 — the token may lack access to that resource.'
  if (status === 422)
    return 'GitHub rejected the request (422) — the content may be invalid or too long.'
  return 'Could not reach GitHub. Check your connection and try again.'
}
