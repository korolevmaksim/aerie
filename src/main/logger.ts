import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { redact } from './redact'

/**
 * Structured, append-only logging for the main process (SPEC §7 — "structured
 * logs, no secrets"). Lines are JSON, one per entry, under <userData>/logs.
 * As a backstop, anything resembling a GitHub token is redacted before write,
 * so a grep of the logs can never reveal a token.
 */

type Level = 'info' | 'warn' | 'error'

function logFilePath(): string | null {
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    return join(dir, 'aerie.log')
  } catch {
    return null
  }
}

function write(level: Level, msg: string, meta?: Record<string, unknown>): void {
  const entry = redact({ ts: new Date().toISOString(), level, msg, ...meta }) as Record<
    string,
    unknown
  >
  const line = `${JSON.stringify(entry)}\n`
  const path = logFilePath()
  if (path) {
    try {
      appendFileSync(path, line)
    } catch {
      // logging must never throw
    }
  }
  const consoleFn = level === 'error' ? console.error : console.log
  consoleFn(`[aerie] ${msg}`, meta ? redact(meta) : '')
}

export const log = {
  info: (msg: string, meta?: Record<string, unknown>): void => write('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>): void => write('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>): void => write('error', msg, meta)
}
