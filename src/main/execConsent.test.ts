import { describe, expect, it } from 'vitest'
import type { Agent } from './agentConfig'
import { agentNeedsConsent, agentSignature, isExecAllowed } from './execConsent'

function agent(over: Partial<Agent> & { id: string }): Agent {
  return {
    label: over.id,
    command: 'node',
    args: ['-e', 'x'],
    promptDelivery: 'arg',
    promptPlaceholder: '{{prompt}}',
    outputCapture: 'stdout',
    outputFile: null,
    timeoutSec: 60,
    env: {},
    ...over // provides id (required) + any field overrides
  }
}

describe('agentSignature', () => {
  it('is stable for the same command/args/env', () => {
    const a = agent({ id: 'x', command: 'foo', args: ['a', 'b'], env: { K: 'v' } })
    expect(agentSignature(a)).toBe(agentSignature(agent({ ...a })))
  })
  it('is env-order-independent but argv-order-sensitive', () => {
    const a = agent({ id: 'x', env: { A: '1', B: '2' } })
    const b = agent({ id: 'x', env: { B: '2', A: '1' } })
    expect(agentSignature(a)).toBe(agentSignature(b)) // env sorted
    const c = agent({ id: 'x', args: ['a', 'b'] })
    const d = agent({ id: 'x', args: ['b', 'a'] })
    expect(agentSignature(c)).not.toBe(agentSignature(d)) // argv order matters
  })
  it('changes when the command, args, env, or discovery argv change', () => {
    const base = agent({ id: 'x', command: 'foo', args: ['a'], env: { K: 'v' } })
    const sig = agentSignature(base)
    expect(agentSignature({ ...base, command: 'bar' })).not.toBe(sig)
    expect(agentSignature({ ...base, args: ['a', 'b'] })).not.toBe(sig)
    expect(agentSignature({ ...base, env: { K: 'w' } })).not.toBe(sig)
    expect(
      agentSignature({ ...base, modelDiscovery: { kind: 'command', argv: ['m'], format: 'lines' } })
    ).not.toBe(sig)
  })
})

describe('isExecAllowed', () => {
  it('always allows a shipped (author-vetted) agent regardless of consent', () => {
    expect(
      isExecAllowed({ isShipped: true, signature: 'abc', consentedSignature: undefined })
    ).toBe(true)
  })
  it('allows a user agent only when the consent matches its current signature', () => {
    expect(isExecAllowed({ isShipped: false, signature: 'abc', consentedSignature: 'abc' })).toBe(
      true
    )
    expect(isExecAllowed({ isShipped: false, signature: 'abc', consentedSignature: 'OLD' })).toBe(
      false
    )
    expect(
      isExecAllowed({ isShipped: false, signature: 'abc', consentedSignature: undefined })
    ).toBe(false)
  })
  it('never allows an empty signature to match', () => {
    expect(isExecAllowed({ isShipped: false, signature: '', consentedSignature: '' })).toBe(false)
  })
})

describe('agentNeedsConsent', () => {
  const user = agent({ id: 'mine', command: 'evil', args: ['--pwn'] })
  it('a shipped agent never needs consent', () => {
    expect(agentNeedsConsent(user, true, undefined)).toBe(false)
  })
  it('a user agent needs consent until its current signature is approved', () => {
    expect(agentNeedsConsent(user, false, undefined)).toBe(true)
    expect(agentNeedsConsent(user, false, agentSignature(user))).toBe(false)
    // editing the command invalidates prior consent
    const consented = agentSignature(user)
    expect(agentNeedsConsent({ ...user, command: 'eviler' }, false, consented)).toBe(true)
  })
})
