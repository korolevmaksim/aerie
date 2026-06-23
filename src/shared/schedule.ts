// Pure helpers for a pipeline's `schedule` trigger interval. A scheduled pipeline stores its
// cadence as a compact `<N><unit>` string (e.g. "30m", "6h", "2d") in `Pipeline.schedule`; the
// poller parses it to a poll interval, the editor splits/builds it. Shared by main + renderer so
// the wire format has a single definition. Electron-free + unit-tested.

export type ScheduleUnit = 'm' | 'h' | 'd'

export const SCHEDULE_UNITS: ScheduleUnit[] = ['m', 'h', 'd']

/** Human labels for the unit picker. */
export const SCHEDULE_UNIT_LABEL: Record<ScheduleUnit, string> = {
  m: 'minutes',
  h: 'hours',
  d: 'days'
}

const UNIT_MS: Record<ScheduleUnit, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000
}

/** Floor on a schedule interval — guards against a runaway poll cadence (and divide-by-tiny). */
export const MIN_SCHEDULE_MS = 60_000 // 1 minute

const SCHEDULE_RE = /^(\d+)\s*([mhd])$/

/**
 * Parse a `<N><unit>` schedule string to milliseconds. Returns null when absent, malformed, or
 * below the 1-minute floor — callers treat null as "not a valid schedule" (no watch).
 */
export function parseScheduleMs(schedule: string | null | undefined): number | null {
  if (!schedule) return null
  const m = SCHEDULE_RE.exec(schedule.trim())
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isInteger(n) || n <= 0) return null
  const ms = n * UNIT_MS[m[2] as ScheduleUnit]
  return ms >= MIN_SCHEDULE_MS ? ms : null
}

/** Build the canonical schedule string from an editor's number + unit. */
export function formatSchedule(every: number, unit: ScheduleUnit): string {
  return `${every}${unit}`
}

/** Split a stored schedule string into editor parts, falling back to a sensible default. */
export function parseScheduleParts(schedule: string | null | undefined): {
  every: number
  unit: ScheduleUnit
} {
  const m = schedule ? SCHEDULE_RE.exec(schedule.trim()) : null
  if (m) {
    const n = Number(m[1])
    if (Number.isInteger(n) && n > 0) return { every: n, unit: m[2] as ScheduleUnit }
  }
  return { every: 6, unit: 'h' }
}
