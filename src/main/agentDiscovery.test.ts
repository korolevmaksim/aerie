import { describe, expect, it } from 'vitest'
import type { Agent, ModelDiscovery } from './agentConfig'
import { discoverAllModels, discoverModels, overlayModels, parseModelList } from './agentDiscovery'

function agent(id: string, command: string, modelDiscovery?: ModelDiscovery): Agent {
  return {
    id,
    label: id,
    command,
    detect: command,
    args: [],
    promptDelivery: 'arg',
    promptPlaceholder: '{{prompt}}',
    outputCapture: 'stdout',
    outputFile: null,
    timeoutSec: 60,
    env: {},
    modelDiscovery
  }
}

const linesProbe = (stdout: string): ModelDiscovery => ({
  kind: 'command',
  // node prints the canned stdout then exits — a stand-in for `opencode models`.
  argv: ['-e', `process.stdout.write(${JSON.stringify(stdout)})`],
  format: 'lines'
})

describe('parseModelList', () => {
  it('keeps one id per line, trims, dedupes', () => {
    const raw = 'opencode/claude-opus-4-8\n  openai/gpt-5.5  \nopencode/claude-opus-4-8\n'
    expect(parseModelList(raw, 'lines')).toEqual(['opencode/claude-opus-4-8', 'openai/gpt-5.5'])
  })
  it('drops blank, banner, and whitespace-containing lines', () => {
    const raw = [
      '# Available models',
      '',
      'provider/a',
      'not a model id',
      '> hint',
      'provider/b'
    ].join('\n')
    expect(parseModelList(raw, 'lines')).toEqual(['provider/a', 'provider/b'])
  })
  it('returns [] for empty input', () => {
    expect(parseModelList('', 'lines')).toEqual([])
  })
  it('drops [-prefixed banner lines and caps the count at 500', () => {
    expect(parseModelList('[info] starting\nprovider/a', 'lines')).toEqual(['provider/a'])
    const many = Array.from({ length: 600 }, (_, i) => `p/m${i}`).join('\n')
    expect(parseModelList(many, 'lines')).toHaveLength(500)
  })
})

describe('overlayModels', () => {
  const seed = ['a/1', 'a/2']
  it('uses the seed (source static) when there is no cache', () => {
    expect(overlayModels(seed, undefined, 'a/1')).toEqual({ models: seed, source: 'static' })
  })
  it('uses the discovered list (source discovered) when cached', () => {
    const r = overlayModels(seed, JSON.stringify(['x/1', 'x/2']), 'x/1')
    expect(r).toEqual({ models: ['x/1', 'x/2'], source: 'discovered' })
  })
  it('falls back to the seed for a corrupt or empty cache', () => {
    expect(overlayModels(seed, 'not json', 'a/1').source).toBe('static')
    expect(overlayModels(seed, '[]', 'a/1').source).toBe('static')
    expect(overlayModels(seed, '[1,2]', 'a/1').source).toBe('static') // non-strings
  })
  it('keeps the selected model present on BOTH the seed and discovered paths', () => {
    // selected not in seed → prepended
    expect(overlayModels(seed, undefined, 'a/legacy').models).toEqual(['a/legacy', 'a/1', 'a/2'])
    // selected not in discovered → prepended
    expect(overlayModels(seed, JSON.stringify(['x/1']), 'a/1').models).toEqual(['a/1', 'x/1'])
  })
})

describe('discoverModels', () => {
  it('runs the probe and returns parsed ids (real node spawn)', async () => {
    const a = agent('opencode', 'node', linesProbe('opencode/x\nopenai/y\n'))
    expect(await discoverModels(a, process.cwd(), 5000)).toEqual(['opencode/x', 'openai/y'])
  })
  it('returns [] when the agent has no descriptor', async () => {
    expect(await discoverModels(agent('codex', 'node'), process.cwd(), 5000)).toEqual([])
  })
  it('returns [] when the binary is not installed (never throws)', async () => {
    const a = agent('ghost', 'definitely-not-a-real-binary-xyz', linesProbe('a/b\n'))
    expect(await discoverModels(a, process.cwd(), 5000)).toEqual([])
  })
})

describe('discoverAllModels', () => {
  it('discovers only AUTHOR-SHIPPED (trusted) agents; skips user-added descriptors', async () => {
    const shipped = agent('opencode', 'node', linesProbe('opencode/x\n'))
    const userAdded = agent('evil', 'node', linesProbe('pwned/model\n'))
    const trusted = new Set(['opencode']) // 'evil' is NOT trusted
    const res = await discoverAllModels([shipped, userAdded], trusted, process.cwd(), 5000)
    expect(res).toEqual([{ agentId: 'opencode', models: ['opencode/x'] }])
  })
  it('omits agents whose probe returns nothing (static seed stays)', async () => {
    const a = agent('opencode', 'node', linesProbe('\n\n'))
    const res = await discoverAllModels([a], new Set(['opencode']), process.cwd(), 5000)
    expect(res).toEqual([])
  })
})
