import { describe, expect, it } from 'vitest'
import type { Agent } from '@shared/types'
import {
  agentToForm,
  blankForm,
  envRowsToRecord,
  formToAgent,
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

  it('preserves non-form base fields (models/detect/modelDiscovery)', () => {
    const base = {
      models: ['m1'],
      detect: 'mybin',
      modelDiscovery: { kind: 'command', argv: ['models'], format: 'lines' }
    } as unknown as Agent
    const r = formToAgent({ ...ok, id: 'x', label: 'x', command: 'c' }, base)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.agent.models).toEqual(['m1'])
      expect(r.agent.detect).toBe('mybin')
      expect(r.agent.modelDiscovery).toEqual({ kind: 'command', argv: ['models'], format: 'lines' })
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
      kind: 'tool'
    }
    const f = agentToForm(a)
    expect(f).toMatchObject({
      id: 'x',
      command: 'node',
      argsText: '-e\ny',
      timeoutSec: '120',
      kind: 'tool'
    })
    expect(f.env).toEqual([{ key: 'K', value: 'v' }])
    // round-trips back
    const back = formToAgent(f, a)
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.agent).toMatchObject({ id: 'x', args: ['-e', 'y'], env: { K: 'v' } })
  })
})
