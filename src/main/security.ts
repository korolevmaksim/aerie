import type { IpcMainInvokeEvent } from 'electron'

/**
 * Navigation / sender trust boundary for the main process. The renderer is the
 * only legitimate caller of the IPC surface, and it must never navigate away
 * from the app's own content. These helpers enforce that (SPEC §4 — privileged
 * work stays in main; the renderer reaches it only through the typed bridge).
 */

/** True for the app's own renderer content: the dev server origin, or the file:// bundle. */
export function isInternalUrl(url: string): boolean {
  const devBase = process.env['ELECTRON_RENDERER_URL']
  if (devBase) {
    // Compare ORIGINS, not a string prefix: a prefix match would treat
    // http://localhost:5173.evil.com as internal.
    try {
      return new URL(url).origin === new URL(devBase).origin
    } catch {
      return false
    }
  }
  return url.startsWith('file://')
}

/** Only http(s) targets may be handed to the OS shell for opening externally. */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * Rejects IPC calls that did not originate from the app's own renderer frame.
 * Defense-in-depth: even if the renderer were navigated/abducted, privileged
 * channels stay unreachable from foreign origins.
 */
export function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url
  return typeof url === 'string' && isInternalUrl(url)
}
