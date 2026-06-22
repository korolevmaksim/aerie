import { describe, expect, it } from 'vitest'
import type { Agent } from './agentConfig'
import {
  gatherGroundTruth,
  isToolRelevant,
  runToolCapture,
  selectGroundingTools
} from './grounding'

function tool(id: string, command: string, args: string[] = []): Agent {
  return {
    id,
    label: id,
    command,
    detect: command,
    args,
    promptDelivery: 'arg',
    promptPlaceholder: '{{prompt}}',
    outputCapture: 'stdout',
    outputFile: null,
    timeoutSec: 60,
    env: {},
    kind: 'tool'
  }
}

describe('isToolRelevant', () => {
  it('gates lint/type tools by changed-file extension', () => {
    expect(isToolRelevant('eslint', ['src/a.ts'])).toBe(true)
    expect(isToolRelevant('eslint', ['src/a.py'])).toBe(false)
    expect(isToolRelevant('ruff', ['src/a.py'])).toBe(true)
    expect(isToolRelevant('tsc', ['src/a.ts'])).toBe(true)
  })
  it('treats gitleaks (and unknown tools) as always relevant', () => {
    expect(isToolRelevant('gitleaks', ['anything.bin'])).toBe(true)
    expect(isToolRelevant('mystery', ['anything.bin'])).toBe(true)
  })
})

describe('selectGroundingTools', () => {
  it('keeps installed, relevant kind:tool agents only', () => {
    const installedRelevant = tool('eslint', 'node') // node is installed; .ts relevant
    const notInstalled = tool('ruff', 'definitely-not-a-real-binary-xyz')
    const notRelevant = tool('ruff', 'node') // ruff on a .ts change is irrelevant
    const llmAgent: Agent = { ...tool('codex', 'node'), kind: 'agent' }
    const picked = selectGroundingTools(
      [installedRelevant, notInstalled, notRelevant, llmAgent],
      ['x.ts']
    )
    expect(picked.map((t) => t.id)).toEqual(['eslint'])
  })
})

describe('runToolCapture', () => {
  it('captures stdout from a real process', async () => {
    const echo = tool('x', 'node', ['-e', 'process.stdout.write("hello")'])
    expect(await runToolCapture(echo, process.cwd(), {}, 5000)).toBe('hello')
  })
  it('resolves "" for a missing command (never throws)', async () => {
    const bad = tool('x', 'definitely-not-a-real-binary-xyz', [])
    expect(await runToolCapture(bad, process.cwd(), {}, 5000)).toBe('')
  })
})

describe('gatherGroundTruth', () => {
  it('runs a real tool and renders its findings as ground truth', async () => {
    // A fake "eslint" tool: node prints eslint-shaped JSON so parseToolOutput('eslint') applies.
    const json = JSON.stringify([
      {
        filePath: 'x.ts',
        messages: [{ ruleId: 'no-debugger', severity: 2, message: 'd', line: 1 }]
      }
    ])
    const fakeEslint = tool('eslint', 'node', [
      '-e',
      `process.stdout.write(${JSON.stringify(json)})`
    ])
    const res = await gatherGroundTruth({
      agents: [fakeEslint],
      cwd: process.cwd(),
      diff: '', // no ranges → no scoping
      diffFile: '',
      changedFiles: ['x.ts']
    })
    expect(res.toolsRun).toBe(1)
    expect(res.findingsCount).toBe(1)
    expect(res.groundTruth).toContain('no-debugger')
  })

  it('scopes findings to the diff ranges when a diff is provided', async () => {
    const json = JSON.stringify([
      {
        filePath: 'x.ts',
        messages: [
          { ruleId: 'in', severity: 2, message: 'in range', line: 2 },
          { ruleId: 'out', severity: 2, message: 'out of range', line: 99 }
        ]
      }
    ])
    const fakeEslint = tool('eslint', 'node', [
      '-e',
      `process.stdout.write(${JSON.stringify(json)})`
    ])
    const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -1,2 +1,3 @@', '+a', ' b'].join('\n')
    const res = await gatherGroundTruth({
      agents: [fakeEslint],
      cwd: process.cwd(),
      diff,
      diffFile: '',
      changedFiles: ['x.ts']
    })
    expect(res.findingsCount).toBe(1)
    expect(res.groundTruth).toContain('in range')
    expect(res.groundTruth).not.toContain('out of range')
  })

  it('returns an empty result when no tool is relevant/installed', async () => {
    const res = await gatherGroundTruth({
      agents: [tool('ruff', 'definitely-not-a-real-binary-xyz')],
      cwd: process.cwd(),
      diff: '',
      diffFile: '',
      changedFiles: ['x.ts']
    })
    expect(res).toEqual({ groundTruth: '', findingsCount: 0, toolsRun: 0 })
  })
})
