import { describe, expect, it } from 'vitest'
import type { Agent } from '@shared/types'
import {
  agentToForm,
  blankForm,
  envRowsToRecord,
  formToAgent,
  isAgentFormDirty,
  parseArgs,
  recordToEnvRows
} from './agentForm'

describe('parseArgs / serializeArgs', () => {
  it('splits one arg per line, dropping blanks + trailing space', () => {
    expect(parseArgs('a\n  \nb \n')).toEqual(['a', 'b'])
  })
})

describe('env rows', () => {
  it('round-trips and drops empty keys (last write wins)', () => {
    expect(
      envRowsToRecord([
        { key: 'A', value: '1' },
        { key: '', value: 'x' }
      ])
    ).toEqual({ A: '1' })
    expect(recordToEnvRows({ A: '1' })).toEqual([{ key: 'A', value: '1' }])
  })
})

describe('isAgentFormDirty', () => {
  it('detects nested edits against the original form state', () => {
    const initial = { ...blankForm(), id: 'x', label: 'X', command: 'codex' }
    expect(isAgentFormDirty({ ...initial }, initial)).toBe(false)
    expect(isAgentFormDirty({ ...initial, env: [{ key: 'A', value: '1' }] }, initial)).toBe(true)
  })
})

describe('formToAgent', () => {
  const ok = blankForm()
  it('builds a valid agent from a good form', () => {
    const r = formToAgent({ ...ok, id: 'mine', label: 'Mine', command: 'node', argsText: 'a\nb' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.agent).toMatchObject({
        id: 'mine',
        command: 'node',
        args: ['a', 'b'],
        kind: 'agent'
      })
      expect(r.agent.outputFile).toBeNull()
    }
  })

  it('rejects a bad id, empty label/command, bad timeout, no args', () => {
    expect(formToAgent({ ...ok, id: 'Bad Id', label: 'x', command: 'c' }).ok).toBe(false)
    expect(formToAgent({ ...ok, id: 'ok', label: '', command: 'c' }).ok).toBe(false)
    expect(formToAgent({ ...ok, id: 'ok', label: 'x', command: '' }).ok).toBe(false)
    expect(formToAgent({ ...ok, id: 'ok', label: 'x', command: 'c', timeoutSec: '0' }).ok).toBe(
      false
    )
    expect(formToAgent({ ...ok, id: 'ok', label: 'x', command: 'c', argsText: '' }).ok).toBe(false)
  })

  it('requires an output file when capturing from a file', () => {
    expect(
      formToAgent({
        ...ok,
        id: 'o',
        label: 'x',
        command: 'c',
        outputCapture: 'file',
        outputFile: ''
      }).ok
    ).toBe(false)
    const r = formToAgent({
      ...ok,
      id: 'o',
      label: 'x',
      command: 'c',
      outputCapture: 'file',
      outputFile: '/tmp/out'
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.agent.outputFile).toBe('/tmp/out')
  })

  it('preserves non-form base fields (detect/modelDiscovery/successExitCodes)', () => {
    const base = {
      detect: 'mybin',
      successExitCodes: [0, 1],
      modelDiscovery: { kind: 'command', argv: ['models'], format: 'lines' }
    } as unknown as Agent
    const r = formToAgent({ ...ok, id: 'x', label: 'x', command: 'c' }, base)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.agent.detect).toBe('mybin')
      expect(r.agent.successExitCodes).toEqual([0, 1])
      expect(r.agent.modelDiscovery).toEqual({ kind: 'command', argv: ['models'], format: 'lines' })
    }
  })

  it('round-trips the model/models/reasoning/reasoningLevels fields', () => {
    const r = formToAgent({
      ...ok,
      id: 'x',
      label: 'x',
      command: 'c',
      models: ['fast', 'slow'],
      model: 'slow',
      reasoningLevels: ['low', 'medium', 'high'],
      reasoning: 'high'
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.agent.models).toEqual(['fast', 'slow'])
      expect(r.agent.model).toBe('slow')
      expect(r.agent.reasoningLevels).toEqual(['low', 'medium', 'high'])
      expect(r.agent.reasoning).toBe('high')
    }
  })

  it('clears reasoning when there are no reasoning levels (even if a base carried one)', () => {
    const base = { reasoning: 'high', reasoningLevels: ['low', 'high'] } as unknown as Agent
    const r = formToAgent(
      { ...ok, id: 'x', label: 'x', command: 'c', reasoning: '', reasoningLevels: [] },
      base
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.agent.reasoningLevels).toBeUndefined()
      expect(r.agent.reasoning).toBeUndefined()
    }
  })

  it('ensures the default model is a member of models (pushes a set-but-missing one)', () => {
    const r = formToAgent({
      ...ok,
      id: 'x',
      label: 'x',
      command: 'c',
      models: ['a', 'b'],
      model: 'c' // not in the list
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.agent.models).toEqual(['a', 'b', 'c'])
      expect(r.agent.model).toBe('c')
    }
  })

  it('adopts the first model as default when none is set, and clears model with no models', () => {
    const withModels = formToAgent({
      ...ok,
      id: 'x',
      label: 'x',
      command: 'c',
      models: ['a', 'b'],
      model: ''
    })
    expect(withModels.ok).toBe(true)
    if (withModels.ok) expect(withModels.agent.model).toBe('a')

    const noModels = formToAgent({
      ...ok,
      id: 'x',
      label: 'x',
      command: 'c',
      models: [],
      model: 'stale'
    })
    expect(noModels.ok).toBe(true)
    if (noModels.ok) {
      expect(noModels.agent.models).toBeUndefined()
      expect(noModels.agent.model).toBeUndefined()
    }
  })
})

describe('agentToForm', () => {
  it('maps an agent back into editable form fields', () => {
    const a: Agent = {
      id: 'x',
      label: 'X',
      command: 'node',
      args: ['-e', 'y'],
      promptDelivery: 'arg',
      promptPlaceholder: '{{prompt}}',
      outputCapture: 'stdout',
      outputFile: null,
      timeoutSec: 120,
      env: { K: 'v' },
      kind: 'tool',
      models: ['fast', 'slow'],
      model: 'slow',
      reasoningLevels: ['low', 'high'],
      reasoning: 'low'
    }
    const f = agentToForm(a)
    expect(f).toMatchObject({
      id: 'x',
      command: 'node',
      argsText: '-e\ny',
      timeoutSec: '120',
      kind: 'tool',
      models: ['fast', 'slow'],
      model: 'slow',
      reasoningLevels: ['low', 'high'],
      reasoning: 'low'
    })
    expect(f.env).toEqual([{ key: 'K', value: 'v' }])
    // round-trips back
    const back = formToAgent(f, a)
    expect(back.ok).toBe(true)
    if (back.ok)
      expect(back.agent).toMatchObject({
        id: 'x',
        args: ['-e', 'y'],
        env: { K: 'v' },
        models: ['fast', 'slow'],
        model: 'slow',
        reasoningLevels: ['low', 'high'],
        reasoning: 'low'
      })
  })

  it('defaults the new model/reasoning fields to empty', () => {
    const f = blankForm()
    expect(f.model).toBe('')
    expect(f.models).toEqual([])
    expect(f.reasoning).toBe('')
    expect(f.reasoningLevels).toEqual([])
  })
})
