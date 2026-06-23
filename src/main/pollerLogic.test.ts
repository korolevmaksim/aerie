import { describe, expect, it } from 'vitest'
import type { Pipeline } from '../shared/types'
import {
  buildCommitDelta,
  deriveWatches,
  matchingPipelines,
  selectDueWatches,
  watchKey,
  type RepoInfo,
  type WatchSpec
} from './pollerLogic'

const pipeline = (over: Partial<Pipeline> = {}): Pipeline => ({
  id: 1,
  name: 'CI',
  repoId: 7,
  trigger: 'commit',
  enabled: true,
  scope: {},
  steps: [{ id: 's1', kind: 'agent', ref: 'codex' }],
  action: { kind: 'notify', autoPost: false },
  guardrails: {},
  ...over
})

const repo = (over: Partial<RepoInfo> = {}): RepoInfo => ({
  id: 7,
  fullName: 'o/r',
  defaultBranch: 'main',
  accountId: 3,
  ...over
})

const spec: WatchSpec = {
  repoId: 7,
  accountId: 3,
  repoFullName: 'o/r',
  refType: 'commit',
  ref: 'main',
  scheduleMs: null
}

describe('deriveWatches', () => {
  const lookup = (map: Record<number, RepoInfo>) => (id: number) => map[id] ?? null

  it('makes one watch per commit pipeline on its repo default branch', () => {
    const ws = deriveWatches([pipeline()], lookup({ 7: repo() }))
    expect(ws).toEqual([spec])
  })

  it('dedupes several pipelines on the same repo to a single watch', () => {
    const ws = deriveWatches(
      [pipeline({ id: 1 }), pipeline({ id: 2 }), pipeline({ id: 3 })],
      lookup({ 7: repo() })
    )
    expect(ws).toHaveLength(1)
  })

  it('skips non-commit triggers, missing repos, and repos with no default branch', () => {
    expect(deriveWatches([pipeline({ trigger: 'pr' })], lookup({ 7: repo() }))).toEqual([])
    expect(deriveWatches([pipeline({ trigger: 'manual' })], lookup({ 7: repo() }))).toEqual([])
    expect(deriveWatches([pipeline()], lookup({}))).toEqual([]) // repo not found
    expect(deriveWatches([pipeline()], lookup({ 7: repo({ defaultBranch: null }) }))).toEqual([])
  })

  it('produces distinct watches for distinct repos', () => {
    const ws = deriveWatches(
      [pipeline({ id: 1, repoId: 7 }), pipeline({ id: 2, repoId: 8 })],
      lookup({ 7: repo(), 8: repo({ id: 8, fullName: 'o/r2', accountId: 5 }) })
    )
    expect(ws).toHaveLength(2)
    expect(ws.map((w) => w.repoFullName).sort()).toEqual(['o/r', 'o/r2'])
  })

  it('a schedule pipeline produces a watch carrying its fixed interval (ms)', () => {
    const ws = deriveWatches(
      [pipeline({ trigger: 'schedule', schedule: '6h' })],
      lookup({ 7: repo() })
    )
    expect(ws).toEqual([{ ...spec, scheduleMs: 6 * 3_600_000 }])
  })

  it('skips a schedule pipeline with no/invalid cadence', () => {
    expect(deriveWatches([pipeline({ trigger: 'schedule' })], lookup({ 7: repo() }))).toEqual([])
    expect(
      deriveWatches([pipeline({ trigger: 'schedule', schedule: 'nope' })], lookup({ 7: repo() }))
    ).toEqual([])
  })

  it('a commit pipeline sharing the branch forces rate-based (scheduleMs null) on the merged watch', () => {
    const ws = deriveWatches(
      [
        pipeline({ id: 1, trigger: 'schedule', schedule: '6h' }),
        pipeline({ id: 2, trigger: 'commit' })
      ],
      lookup({ 7: repo() })
    )
    expect(ws).toEqual([{ ...spec, scheduleMs: null }])
  })

  it('two schedule pipelines on one branch merge to the most-frequent interval', () => {
    const ws = deriveWatches(
      [
        pipeline({ id: 1, trigger: 'schedule', schedule: '6h' }),
        pipeline({ id: 2, trigger: 'schedule', schedule: '30m' })
      ],
      lookup({ 7: repo() })
    )
    expect(ws).toEqual([{ ...spec, scheduleMs: 30 * 60_000 }])
  })
})

describe('watchKey', () => {
  it('is stable and repo+ref specific', () => {
    expect(watchKey(spec)).toBe('7:commit:main')
    expect(watchKey({ ...spec, ref: 'dev' })).toBe('7:commit:dev')
  })
})

describe('selectDueWatches', () => {
  const a: WatchSpec = { ...spec, repoId: 1, ref: 'main' }
  const b: WatchSpec = { ...spec, repoId: 2, ref: 'main' }
  const c: WatchSpec = { ...spec, repoId: 3, ref: 'main' }

  it('returns watches scheduled at/before now, soonest first, capped', () => {
    const sched: Record<string, number> = {
      '1:commit:main': 500,
      '2:commit:main': 100,
      '3:commit:main': 2000 // not due
    }
    const at = (k: string): number | undefined => sched[k]
    expect(selectDueWatches([a, b, c], at, 1000, 0).map((w) => w.repoId)).toEqual([2, 1])
    expect(selectDueWatches([a, b, c], at, 1000, 1).map((w) => w.repoId)).toEqual([2]) // cap
  })

  it('treats a never-scheduled watch as due (defaults to 0)', () => {
    expect(selectDueWatches([a], () => undefined, 1000, 0)).toEqual([a])
  })

  it('drops the latest-scheduled overflow watches when capped, keeping the soonest', () => {
    const sched: Record<string, number> = {
      '1:commit:main': 300,
      '2:commit:main': 100,
      '3:commit:main': 200
    }
    const at = (k: string): number | undefined => sched[k]
    // cap 2 over three due → keep the two soonest (b@100, c@200), drop the latest (a@300).
    expect(selectDueWatches([a, b, c], at, 1000, 2).map((w) => w.repoId)).toEqual([2, 3])
  })

  it('keeps input order on equal schedule times (stable)', () => {
    const at = (): number => 0 // all due at the same time
    expect(selectDueWatches([a, b, c], at, 1000, 0).map((w) => w.repoId)).toEqual([1, 2, 3])
  })
})

describe('buildCommitDelta', () => {
  it('builds a commit DeltaContext from a watch + head sha', () => {
    const d = buildCommitDelta(spec, 'deadbeef', { catalogVersion: 'v1', promptHash: 'p1' })
    expect(d).toEqual({
      accountId: 3,
      repoId: 7,
      refType: 'commit',
      ref: 'main',
      headSha: 'deadbeef',
      baseSha: null,
      scope: { branch: 'main' },
      catalogVersion: 'v1',
      promptHash: 'p1'
    })
  })
})

describe('matchingPipelines', () => {
  it('keeps this repo + commit and valid-schedule pipelines; drops other repos/triggers', () => {
    const ps = [
      pipeline({ id: 1, repoId: 7, trigger: 'commit' }),
      pipeline({ id: 2, repoId: 8, trigger: 'commit' }), // other repo
      pipeline({ id: 3, repoId: 7, trigger: 'pr' }), // non-firing trigger
      pipeline({ id: 4, repoId: 7, trigger: 'schedule', schedule: '6h' }), // scheduled → fires on new head
      pipeline({ id: 5, repoId: 7, trigger: 'schedule', schedule: 'bad' }), // invalid cadence → dropped
      pipeline({ id: 6, repoId: 7, trigger: 'manual' }) // manual-only
    ]
    expect(matchingPipelines(ps, spec).map((p) => p.id)).toEqual([1, 4])
  })
})
