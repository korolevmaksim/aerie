import { describe, expect, it } from 'vitest'
import type { PullRequestFeedbackItem } from '../shared/types'
import {
  buildPullRequestFeedbackPromptContextFromItems,
  feedbackBodyHash,
  normalizeFeedbackBody,
  summarizePullRequestFeedbackItems
} from './prFeedbackModel'

function feedback(overrides: Partial<PullRequestFeedbackItem>): PullRequestFeedbackItem {
  const body = overrides.body ?? 'Body'
  return {
    id: overrides.id ?? 1,
    repoId: overrides.repoId ?? 10,
    prNumber: overrides.prNumber ?? 42,
    kind: overrides.kind ?? 'review_thread_comment',
    sourceId: overrides.sourceId ?? `review:${overrides.id ?? 1}`,
    threadId: overrides.threadId ?? 'thread:1',
    isResolved: overrides.isResolved === undefined ? false : overrides.isResolved,
    isOutdated: overrides.isOutdated === undefined ? false : overrides.isOutdated,
    path: overrides.path ?? 'src/app.ts',
    line: overrides.line ?? 12,
    authorLogin: overrides.authorLogin ?? 'alice',
    body,
    bodyHash: overrides.bodyHash ?? feedbackBodyHash(body),
    url: overrides.url ?? 'https://github.com/octo/repo/pull/42#discussion_r1',
    createdAt: overrides.createdAt ?? '2026-07-03T10:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-07-03T10:05:00.000Z',
    syncedAt: overrides.syncedAt ?? '2026-07-03T10:10:00.000Z'
  }
}

describe('prFeedbackModel', () => {
  it('redacts and hashes feedback bodies before persistence', () => {
    const raw = ['please check sk', 'proj', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('-')
    const normalized = normalizeFeedbackBody(raw)
    expect(normalized).toContain('[REDACTED]')
    expect(normalized).not.toContain('sk-proj-')
    expect(feedbackBodyHash(normalized)).toHaveLength(64)
  })

  it('summarizes general comments and distinct thread states', () => {
    const items = [
      feedback({ id: 1, threadId: 't1', isResolved: false, isOutdated: false }),
      feedback({ id: 2, threadId: 't1', isResolved: false, isOutdated: true }),
      feedback({ id: 3, threadId: 't2', isResolved: true }),
      feedback({ id: 4, kind: 'issue_comment', threadId: null, isResolved: null, path: null })
    ]
    expect(summarizePullRequestFeedbackItems(items)).toMatchObject({
      total: 4,
      issueComments: 1,
      reviewThreadComments: 3,
      unresolvedThreads: 1,
      resolvedThreads: 1,
      outdatedThreads: 1,
      lastSyncedAt: '2026-07-03T10:10:00.000Z'
    })
  })

  it('builds a bounded prompt context prioritizing unresolved changed-file threads', () => {
    const items = [
      feedback({
        id: 1,
        threadId: 'resolved',
        isResolved: true,
        path: 'src/app.ts',
        body: 'Already accepted in this PR.'
      }),
      feedback({
        id: 2,
        threadId: 'unresolved',
        isResolved: false,
        path: 'src/app.ts',
        body: 'Reviewer asked for null handling.'
      }),
      feedback({
        id: 3,
        kind: 'issue_comment',
        threadId: null,
        isResolved: null,
        path: null,
        body: 'General release note request.'
      }),
      feedback({
        id: 4,
        threadId: 'other-file',
        isResolved: false,
        path: 'docs/readme.md',
        body: 'Docs-only request.'
      })
    ]
    const context = buildPullRequestFeedbackPromptContextFromItems(items, ['src/app.ts'], 2)
    expect(context.included).toBe(2)
    expect(context.omitted).toBe(2)
    expect(context.text).toContain('Reviewer asked for null handling.')
    expect(context.text).toContain('General release note request.')
    expect(context.text).not.toContain('Docs-only request.')
    expect(context.text.indexOf('Reviewer asked')).toBeLessThan(
      context.text.indexOf('General release')
    )
  })
})
