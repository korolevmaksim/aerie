import { describe, expect, it } from 'vitest'
import type { ConsensusFinding, RunGroupHistoryItem, RunHistoryItem } from '../shared/types'
import { derivePanelFinishedAt, derivePanelStatus, renderPanelReportMarkdown } from './panelReport'

function run(over: Partial<RunHistoryItem> = {}): RunHistoryItem {
  return {
    id: 1,
    repoId: 7,
    accountId: 3,
    repoFullName: 'octocat/hello-world',
    refType: 'commit',
    refId: 'main',
    headSha: 'abcdef1234567890',
    agentId: 'codex',
    status: 'done',
    exitCode: 0,
    startedAt: '2026-06-23T00:00:00Z',
    finishedAt: '2026-06-23T00:05:00Z',
    outputPath: null,
    postedUrl: null,
    localStatus: 'open',
    localStatusAt: null,
    authorLogin: 'monalisa',
    ...over,
    kind: 'run'
  }
}

function group(over: Partial<RunGroupHistoryItem> = {}): RunGroupHistoryItem {
  return {
    id: 9,
    repoId: 7,
    accountId: 3,
    repoFullName: 'octocat/hello-world',
    refType: 'commit',
    refId: 'main',
    headSha: 'abcdef1234567890',
    status: 'done',
    startedAt: '2026-06-23T00:00:00Z',
    finishedAt: '2026-06-23T00:05:00Z',
    postedUrl: null,
    localStatus: 'open',
    localStatusAt: null,
    authorLogin: 'monalisa',
    runIds: [1, 2],
    agentIds: ['codex', 'claude-code'],
    ...over,
    kind: 'group'
  }
}

function finding(over: Partial<ConsensusFinding> = {}): ConsensusFinding {
  return {
    tool: 'codex',
    ruleId: null,
    severity: 'high',
    file: 'src/app.ts',
    line: 42,
    message: 'Broken invariant',
    agreement: 2,
    ...over
  }
}

describe('panel report helpers', () => {
  it('derives a panel status from child runs', () => {
    expect(derivePanelStatus([run({ status: 'queued' }), run({ status: 'done' })])).toBe('queued')
    expect(derivePanelStatus([run({ status: 'running' }), run({ status: 'done' })])).toBe('running')
    expect(derivePanelStatus([run({ status: 'done' }), run({ status: 'error' })])).toBe('done')
    expect(derivePanelStatus([run({ status: 'error' }), run({ status: 'killed' })])).toBe('error')
  })

  it('uses the latest child finish time only after every child is terminal', () => {
    expect(
      derivePanelFinishedAt([
        run({ status: 'done', finishedAt: '2026-06-23T00:05:00Z' }),
        run({ status: 'running', finishedAt: null })
      ])
    ).toBeNull()
    expect(
      derivePanelFinishedAt([
        run({ status: 'done', finishedAt: '2026-06-23T00:05:00Z' }),
        run({ status: 'error', finishedAt: '2026-06-23T00:07:00Z' })
      ])
    ).toBe('2026-06-23T00:07:00Z')
  })

  it('renders one consolidated markdown report with consensus and agent evidence', () => {
    const markdown = renderPanelReportMarkdown({
      group: group(),
      runs: [run({ id: 1, agentId: 'codex' }), run({ id: 2, agentId: 'claude-code' })],
      consensusFindings: [finding()],
      singleSourceFindings: [finding({ agreement: 1, tool: 'claude-code', message: 'Needs test' })],
      consensusMin: 2,
      totalFindings: 2,
      outputs: new Map([
        [1, 'Codex report'],
        [2, 'Claude report']
      ])
    })

    expect(markdown).toContain('# Aerie panel review')
    expect(markdown).toContain('Findings agreed by at least 2 agents')
    expect(markdown).toContain('HIGH · 2 agents')
    expect(markdown).toContain('Single-source findings to triage')
    expect(markdown).toContain('<summary>codex · done · exit 0</summary>')
    expect(markdown).toContain('Claude report')
  })
})
