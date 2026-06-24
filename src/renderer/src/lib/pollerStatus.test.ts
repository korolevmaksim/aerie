import { describe, expect, it } from 'vitest'
import type { PollerStatus } from '@shared/types'
import { formatPollerStatus } from './pollerStatus'

const NOW = Date.parse('2026-06-23T12:00:00Z')
const iso = (deltaMs: number): string => new Date(NOW + deltaMs).toISOString()

const status = (over: Partial<PollerStatus> = {}): PollerStatus => ({
  running: true,
  enabledPipelineCount: 2,
  activeWatchCount: 1,
  lastPolledAt: iso(-30_000), // 30s ago
  nextPollAt: iso(120_000), // in 2m
  rate: { remaining: 4800, limit: 5000 },
  ...over
})

describe('formatPollerStatus', () => {
  it('renders the full watching line', () => {
    expect(formatPollerStatus(status(), NOW)).toBe(
      'Watching 2 pipelines · next check in ~2m · last checked 30s ago · API 4800/5000'
    )
  })

  it('says paused when not running', () => {
    expect(formatPollerStatus(status({ running: false }), NOW)).toBe('Automation paused')
  })

  it('does not call the idle timer watching when no pipeline is enabled', () => {
    expect(formatPollerStatus(status({ enabledPipelineCount: 0 }), NOW)).toBe(
      'Idle · no enabled pipelines'
    )
  })

  it('flags enabled pipelines that cannot produce a watch', () => {
    expect(formatPollerStatus(status({ activeWatchCount: 0 }), NOW)).toBe(
      'Idle · no runnable watches'
    )
  })

  it('shows "checking now" when the next poll is due/overdue', () => {
    expect(formatPollerStatus(status({ nextPollAt: iso(-1000) }), NOW)).toContain('checking now')
  })

  it('omits last-checked when there was no poll yet', () => {
    const s = formatPollerStatus(status({ lastPolledAt: null }), NOW)
    expect(s).toContain('Watching 2 pipelines')
    expect(s).not.toContain('last checked')
  })

  it('omits the API budget when a rate number is missing', () => {
    expect(
      formatPollerStatus(status({ rate: { remaining: null, limit: 5000 } }), NOW)
    ).not.toContain('API')
    expect(formatPollerStatus(status({ rate: null }), NOW)).not.toContain('API')
  })

  it('uses seconds / minutes / hours buckets', () => {
    expect(
      formatPollerStatus(status({ nextPollAt: iso(45_000), lastPolledAt: null }), NOW)
    ).toContain('next check in 45s')
    expect(
      formatPollerStatus(status({ nextPollAt: iso(3 * 60_000), lastPolledAt: null }), NOW)
    ).toContain('next check in ~3m')
    expect(
      formatPollerStatus(status({ nextPollAt: iso(2 * 3_600_000), lastPolledAt: null }), NOW)
    ).toContain('next check in ~2h')
  })

  it('a bare running poller with no timing is just "Watching"', () => {
    expect(
      formatPollerStatus(
        {
          running: true,
          enabledPipelineCount: 0,
          activeWatchCount: 0,
          lastPolledAt: null,
          nextPollAt: null,
          rate: null
        },
        NOW
      )
    ).toBe('Idle · no enabled pipelines')
    expect(
      formatPollerStatus(
        {
          running: true,
          enabledPipelineCount: 1,
          activeWatchCount: 1,
          lastPolledAt: null,
          nextPollAt: null,
          rate: null
        },
        NOW
      )
    ).toBe('Watching 1 pipeline')
  })
})
