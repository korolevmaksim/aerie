import { describe, expect, it } from 'vitest'
import type { ConsensusResult, Pipeline, PipelineAction, PipelineStep } from '../shared/types'
import { processDelta, runPipelineForDelta, type DeltaContext, type EnginePorts } from './pipelines'
import type { GuardrailState } from './pipelinePlan'

const action = (over: Partial<PipelineAction> = {}): PipelineAction => ({
  kind: 'notify',
  autoPost: false,
  ...over
})

const pipeline = (over: Partial<Pipeline> = {}): Pipeline => ({
  id: 1,
  name: 'CI review',
  repoId: 7,
  trigger: 'commit',
  enabled: true,
  scope: {},
  steps: [{ id: 's1', kind: 'agent', ref: 'codex' }],
  action: action(),
  guardrails: {},
  ...over
})

const delta = (over: Partial<DeltaContext> = {}): DeltaContext => ({
  accountId: 3,
  repoId: 7,
  refType: 'commit',
  ref: 'main',
  headSha: 'a'.repeat(40),
  baseSha: null,
  scope: { branch: 'main' },
  catalogVersion: 'v1',
  promptHash: 'p1',
  ...over
})

const emptyAgg: ConsensusResult = { findings: [], total: 0 }

interface Recorder {
  posts: Array<{ target: string; body: string }>
  notifies: string[]
  startedSteps: string[]
  inserted: number
  inserts: Array<{ trigger: string; action: string; dedupeKey: string }>
  statusUpdates: Array<{ id: number; status: string }>
  postedFlags: number[]
  advanced: number
  events: string[]
}

function fakePorts(
  over: Partial<EnginePorts> = {},
  rec: Recorder = {
    posts: [],
    notifies: [],
    startedSteps: [],
    inserted: 0,
    inserts: [],
    statusUpdates: [],
    postedFlags: [],
    advanced: 0,
    events: []
  }
): { ports: EnginePorts; rec: Recorder } {
  let runIdSeq = 100
  const stepRunId = new Map<number, string>()
  const ports: EnginePorts = {
    nowIso: () => '2026-06-22T00:00:00Z',
    nowMs: () => 1_000_000,
    findCompletedDedupe: () => false,
    insertPipelineRun: (input) => {
      rec.inserted += 1
      rec.inserts.push({
        trigger: input.trigger,
        action: input.action,
        dedupeKey: input.dedupeKey
      })
      return 500 + rec.inserted
    },
    updatePipelineRunStatus: (id, status) => {
      rec.statusUpdates.push({ id, status })
    },
    setPipelineRunPosted: (id) => {
      rec.postedFlags.push(id)
    },
    guardrailState: (): GuardrailState => ({
      nowMs: 1_000_000,
      lastRepoRunStartedAtMs: null,
      pipelineRunStartsLastHourMs: [],
      activeRunCount: 0
    }),
    startStep: (step) => {
      rec.startedSteps.push(step.id)
      rec.events.push(`start:${step.id}`)
      const id = (runIdSeq += 1)
      stepRunId.set(id, step.id)
      return id
    },
    waitForRun: async (runId) => {
      rec.events.push(`wait:${stepRunId.get(runId)}`)
      return 'done'
    },
    aggregate: () => emptyAgg,
    post: async (_action, target, _delta, body) => {
      rec.posts.push({ target, body })
      return 'https://github.test/comment/1'
    },
    notify: (_p, summary) => {
      rec.notifies.push(summary)
    },
    advanceWatch: () => {
      rec.advanced += 1
    },
    log: () => {},
    ...over
  }
  return { ports, rec }
}

describe('runPipelineForDelta — the auto-post gate', () => {
  it('a DISABLED post (autoPost=false) NEVER writes — degrades to stage/notify', async () => {
    const { ports, rec } = fakePorts()
    const out = await runPipelineForDelta(
      pipeline({ action: action({ kind: 'post', autoPost: false, target: 'commit' }) }),
      delta(),
      ports
    )
    expect(rec.posts).toHaveLength(0) // the write port was NEVER reached
    expect(rec.postedFlags).toHaveLength(0)
    expect(rec.notifies).toHaveLength(1) // staged via notify instead
    expect(out).toMatchObject({ ran: true, action: 'stage', posted: false })
  })

  it('an ENABLED post (autoPost=true) writes EXACTLY once and flags posted', async () => {
    const { ports, rec } = fakePorts()
    const out = await runPipelineForDelta(
      pipeline({ trigger: 'pr', action: action({ kind: 'post', autoPost: true, target: 'pr' }) }),
      delta({ refType: 'pr', ref: 'pr:42', scope: {} }),
      ports
    )
    expect(rec.posts).toHaveLength(1)
    expect(rec.posts[0].target).toBe('pr')
    expect(rec.postedFlags).toEqual([501])
    expect(out).toMatchObject({ ran: true, action: 'post', posted: true })
  })

  it('a notify pipeline never writes', async () => {
    const { ports, rec } = fakePorts()
    await runPipelineForDelta(pipeline({ action: action({ kind: 'notify' }) }), delta(), ports)
    expect(rec.posts).toHaveLength(0)
    expect(rec.notifies).toHaveLength(1)
  })

  it('defaults the post target from the delta when unset (commit→commit, pr→pr)', async () => {
    const { ports, rec } = fakePorts()
    await runPipelineForDelta(
      pipeline({ action: action({ kind: 'post', autoPost: true }) }), // no target
      delta(),
      ports
    )
    expect(rec.posts[0].target).toBe('commit')
  })
})

describe('runPipelineForDelta — gates skip without running', () => {
  const expectSkipped = (rec: Recorder): void => {
    expect(rec.inserted).toBe(0)
    expect(rec.startedSteps).toHaveLength(0)
    expect(rec.posts).toHaveLength(0)
  }

  it('skips on a scope miss', async () => {
    const { ports, rec } = fakePorts()
    const out = await runPipelineForDelta(
      pipeline({ scope: { branches: ['release'] } }),
      delta({ scope: { branch: 'main' } }),
      ports
    )
    expect(out).toEqual({ ran: false, reason: 'scope' })
    expectSkipped(rec)
  })

  it('skips on a wrong-trigger / wrong-repo', async () => {
    const { ports } = fakePorts()
    expect((await runPipelineForDelta(pipeline({ trigger: 'pr' }), delta(), ports)).ran).toBe(false)
    expect((await runPipelineForDelta(pipeline({ repoId: 999 }), delta(), ports)).ran).toBe(false)
  })

  it('skips an invalid (cyclic) step graph without running', async () => {
    const { ports, rec } = fakePorts()
    const steps: PipelineStep[] = [
      { id: 'a', kind: 'agent', ref: 'x', dependsOn: ['b'] },
      { id: 'b', kind: 'agent', ref: 'y', dependsOn: ['a'] }
    ]
    const out = await runPipelineForDelta(pipeline({ steps }), delta(), ports)
    expect(out.ran).toBe(false)
    expect(out).toMatchObject({ reason: 'invalid' })
    expectSkipped(rec)
  })

  it('skips when a guardrail blocks', async () => {
    const { ports, rec } = fakePorts({
      guardrailState: () => ({
        nowMs: 1_000_000,
        lastRepoRunStartedAtMs: null,
        pipelineRunStartsLastHourMs: [],
        activeRunCount: 5
      })
    })
    const out = await runPipelineForDelta(
      pipeline({ guardrails: { maxConcurrentRuns: 2 } }),
      delta(),
      ports
    )
    expect(out).toMatchObject({ ran: false, reason: 'guardrail' })
    expectSkipped(rec)
  })

  it('skips when the dedupe key already has a completed run', async () => {
    const { ports, rec } = fakePorts({ findCompletedDedupe: () => true })
    const out = await runPipelineForDelta(pipeline(), delta(), ports)
    expect(out).toEqual({ ran: false, reason: 'dedupe' })
    expectSkipped(rec)
  })
})

describe('runPipelineForDelta — wave barrier + error handling', () => {
  it('runs dependent waves in order (a step waits for its parents to finish)', async () => {
    const { ports, rec } = fakePorts()
    const steps: PipelineStep[] = [
      { id: 's1', kind: 'agent', ref: 'a' },
      { id: 's2', kind: 'agent', ref: 'b', dependsOn: ['s1'] }
    ]
    await runPipelineForDelta(pipeline({ steps }), delta(), ports)
    // s2 must not start until s1's wait has resolved (the barrier).
    expect(rec.events).toEqual(['start:s1', 'wait:s1', 'start:s2', 'wait:s2'])
  })

  it('marks the run error and does not advance/post when a step throws', async () => {
    const { ports, rec } = fakePorts({
      waitForRun: async () => {
        throw new Error('runner blew up')
      }
    })
    const out = await runPipelineForDelta(
      pipeline({ action: action({ kind: 'post', autoPost: true }) }),
      delta(),
      ports
    )
    expect(out).toMatchObject({ ran: false, reason: 'error' })
    expect(rec.posts).toHaveLength(0)
    expect(rec.statusUpdates.at(-1)).toEqual({ id: 501, status: 'error' })
  })

  it('never throws even when a PRE-insert store port fails (resolves to error)', async () => {
    const { ports, rec } = fakePorts({
      insertPipelineRun: () => {
        throw new Error('sqlite is sad')
      }
    })
    const out = await runPipelineForDelta(pipeline(), delta(), ports)
    expect(out).toMatchObject({ ran: false, reason: 'error' })
    // No run was inserted, so there is nothing to mark 'error' and nothing posted.
    expect(rec.statusUpdates).toHaveLength(0)
    expect(rec.posts).toHaveLength(0)
  })
})

describe('processDelta — watch advancement', () => {
  it('advances the watch once when all pipelines settle ok', async () => {
    const { ports, rec } = fakePorts()
    const result = await processDelta([pipeline({ id: 1 }), pipeline({ id: 2 })], delta(), ports)
    expect(result.advanced).toBe(true)
    expect(rec.advanced).toBe(1)
  })

  it('advances even when pipelines SKIP (scope/dedupe/guardrail are settled, not errors)', async () => {
    const { ports, rec } = fakePorts({ findCompletedDedupe: () => true })
    const result = await processDelta([pipeline()], delta(), ports)
    expect(result.advanced).toBe(true)
    expect(rec.advanced).toBe(1)
  })

  it('does NOT advance the watch when any pipeline errors (delta retried)', async () => {
    const { ports, rec } = fakePorts({
      waitForRun: async () => {
        throw new Error('boom')
      }
    })
    const result = await processDelta([pipeline()], delta(), ports)
    expect(result.advanced).toBe(false)
    expect(rec.advanced).toBe(0)
  })

  it('does NOT advance when ONE of several pipelines errors (the good run cannot mask it)', async () => {
    // Pipeline id:2 errors (its step throws); id:1 succeeds. The delta must still be held.
    const { ports, rec } = fakePorts({
      startStep: (step) => (step.ref === 'boom' ? -1 : 1),
      waitForRun: async (runId) => {
        if (runId === -1) throw new Error('boom')
        return 'done'
      }
    })
    const ok = pipeline({ id: 1, steps: [{ id: 's', kind: 'agent', ref: 'ok' }] })
    const bad = pipeline({ id: 2, steps: [{ id: 's', kind: 'agent', ref: 'boom' }] })
    const result = await processDelta([ok, bad], delta(), ports)
    expect(result.advanced).toBe(false)
    expect(rec.advanced).toBe(0)
    expect(result.outcomes).toHaveLength(2)
  })

  it('advances on an empty pipeline list (nothing watches this ref)', async () => {
    const { ports, rec } = fakePorts()
    const result = await processDelta([], delta(), ports)
    expect(result.advanced).toBe(true)
    expect(rec.advanced).toBe(1)
    expect(result.outcomes).toHaveLength(0)
  })
})

describe('runPipelineForDelta — manual + dryRun options', () => {
  it('a manual run bypasses scope, guardrail, and dedupe gates', async () => {
    const { ports, rec } = fakePorts({
      findCompletedDedupe: () => true, // would dedupe-skip a normal run
      guardrailState: () => ({
        nowMs: 1_000_000,
        lastRepoRunStartedAtMs: null,
        pipelineRunStartsLastHourMs: [],
        activeRunCount: 9
      })
    })
    const out = await runPipelineForDelta(
      pipeline({ scope: { branches: ['release'] }, guardrails: { maxConcurrentRuns: 1 } }),
      delta({ scope: { branch: 'main' } }), // scope miss for an auto run
      ports,
      { manual: true }
    )
    expect(out.ran).toBe(true)
    expect(rec.inserts[0].trigger).toBe('manual') // recorded as a manual run
  })

  it('a dryRun on an ENABLED-post pipeline writes NOTHING and records action=stage', async () => {
    const { ports, rec } = fakePorts()
    const out = await runPipelineForDelta(
      pipeline({ action: action({ kind: 'post', autoPost: true, target: 'commit' }) }),
      delta(),
      ports,
      { manual: true, dryRun: true }
    )
    expect(rec.posts).toHaveLength(0) // the write port was NEVER reached
    expect(rec.postedFlags).toHaveLength(0)
    expect(out).toMatchObject({ ran: true, action: 'stage', posted: false })
    expect(rec.inserts[0].action).toBe('stage')
  })

  it('a dryRun salts the dedupe key so it cannot suppress a real auto run', async () => {
    const { ports, rec } = fakePorts()
    await runPipelineForDelta(pipeline(), delta(), ports, { manual: true, dryRun: true })
    expect(rec.inserts[0].dedupeKey.startsWith('dryrun:')).toBe(true)
  })

  it('a non-dry run-now on an enabled-post pipeline DOES post (per the opt-in)', async () => {
    const { ports, rec } = fakePorts()
    const out = await runPipelineForDelta(
      pipeline({ action: action({ kind: 'post', autoPost: true, target: 'commit' }) }),
      delta(),
      ports,
      { manual: true } // run-now, not dry-run
    )
    expect(rec.posts).toHaveLength(1)
    expect(out).toMatchObject({ ran: true, action: 'post', posted: true })
  })

  it('a non-dry run-now keeps the CANONICAL dedupe key (so a later auto run correctly skips)', async () => {
    const { ports, rec } = fakePorts()
    await runPipelineForDelta(pipeline(), delta(), ports, { manual: true })
    expect(rec.inserts[0].dedupeKey.startsWith('dryrun:')).toBe(false) // un-salted = real work done
  })
})
