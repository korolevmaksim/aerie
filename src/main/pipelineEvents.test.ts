import { afterEach, describe, expect, it } from 'vitest'
import type { PipelineRunChange } from '../shared/types'
import { emitPipelineRunChange, onPipelineRunChange, resetPipelineEvents } from './pipelineEvents'

const change = (over: Partial<PipelineRunChange> = {}): PipelineRunChange => ({
  pipelineId: 1,
  pipelineRunId: 10,
  status: 'pending',
  action: 'notify',
  posted: false,
  ...over
})

afterEach(() => resetPipelineEvents())

describe('pipelineEvents', () => {
  it('delivers an emitted change to a subscriber', () => {
    const seen: PipelineRunChange[] = []
    onPipelineRunChange((c) => seen.push(c))
    emitPipelineRunChange(change({ status: 'running' }))
    expect(seen).toEqual([change({ status: 'running' })])
  })

  it('delivers to multiple subscribers', () => {
    let a = 0
    let b = 0
    onPipelineRunChange(() => (a += 1))
    onPipelineRunChange(() => (b += 1))
    emitPipelineRunChange(change())
    expect(a).toBe(1)
    expect(b).toBe(1)
  })

  it('the returned unsubscribe stops delivery', () => {
    let count = 0
    const off = onPipelineRunChange(() => (count += 1))
    emitPipelineRunChange(change())
    off()
    emitPipelineRunChange(change())
    expect(count).toBe(1)
  })

  it('reset clears all subscribers', () => {
    let count = 0
    onPipelineRunChange(() => (count += 1))
    resetPipelineEvents()
    emitPipelineRunChange(change())
    expect(count).toBe(0)
  })
})
