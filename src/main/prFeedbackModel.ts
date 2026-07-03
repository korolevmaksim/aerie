import { createHash } from 'crypto'
import type { PullRequestFeedbackItem, PullRequestFeedbackSummary } from '../shared/types'
import { redactText } from './redact'

const MAX_FEEDBACK_BODY_LENGTH = 4000
const MAX_PROMPT_FEEDBACK_ENTRIES = 8
const MAX_PROMPT_FIELD_LENGTH = 220

export interface PullRequestFeedbackPromptContext {
  text: string
  considered: number
  included: number
  omitted: number
  unresolvedThreads: number
  resolvedThreads: number
  outdatedThreads: number
}

export function normalizeFeedbackBody(body: unknown): string {
  if (typeof body !== 'string') return ''
  return redactText(body.trim()).slice(0, MAX_FEEDBACK_BODY_LENGTH)
}

export function feedbackBodyHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

export function summarizePullRequestFeedbackItems(
  items: readonly PullRequestFeedbackItem[]
): PullRequestFeedbackSummary {
  const threadState = new Map<
    string,
    { resolved: boolean | null; outdated: boolean | null; kind: PullRequestFeedbackItem['kind'] }
  >()
  let issueComments = 0
  let reviewThreadComments = 0
  let lastSyncedAt: string | null = null

  for (const item of items) {
    if (item.kind === 'issue_comment') {
      issueComments += 1
    } else {
      reviewThreadComments += 1
      const key = item.threadId ?? item.sourceId
      const existing = threadState.get(key)
      threadState.set(key, {
        kind: item.kind,
        resolved: existing?.resolved === false ? false : item.isResolved,
        outdated: existing?.outdated === true ? true : item.isOutdated
      })
    }
    if (!lastSyncedAt || item.syncedAt > lastSyncedAt) lastSyncedAt = item.syncedAt
  }

  let unresolvedThreads = 0
  let resolvedThreads = 0
  let outdatedThreads = 0
  for (const state of threadState.values()) {
    if (state.kind !== 'review_thread_comment') continue
    if (state.resolved === false) unresolvedThreads += 1
    if (state.resolved === true) resolvedThreads += 1
    if (state.outdated === true) outdatedThreads += 1
  }

  return {
    total: items.length,
    issueComments,
    reviewThreadComments,
    unresolvedThreads,
    resolvedThreads,
    outdatedThreads,
    lastSyncedAt
  }
}

function normalizeRepoPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^(a|b)\//, '')
    .trim()
}

function truncatePromptField(value: string): string {
  const singleLine = redactText(value).replace(/\s+/g, ' ').trim()
  if (singleLine.length <= MAX_PROMPT_FIELD_LENGTH) return singleLine
  return `${singleLine.slice(0, MAX_PROMPT_FIELD_LENGTH - 3)}...`
}

function itemUpdatedAt(item: PullRequestFeedbackItem): string {
  return item.updatedAt ?? item.createdAt
}

function itemPriority(item: PullRequestFeedbackItem): number {
  if (item.kind === 'review_thread_comment' && item.isResolved === false) return 0
  if (item.kind === 'issue_comment') return 1
  if (item.kind === 'review_thread_comment' && item.isResolved === true) return 2
  return 3
}

function feedbackLabel(item: PullRequestFeedbackItem): string {
  if (item.kind === 'issue_comment') return 'PR comment'
  const state =
    item.isResolved === false ? 'unresolved' : item.isResolved === true ? 'resolved' : 'unknown'
  const outdated = item.isOutdated ? ', outdated' : ''
  return `${state}${outdated} review thread`
}

function feedbackLocation(item: PullRequestFeedbackItem): string {
  if (!item.path) return 'PR'
  return `${normalizeRepoPath(item.path)}${item.line !== null ? `:${item.line}` : ''}`
}

export function buildPullRequestFeedbackPromptContextFromItems(
  items: readonly PullRequestFeedbackItem[],
  changedFiles: readonly string[],
  maxEntries = MAX_PROMPT_FEEDBACK_ENTRIES
): PullRequestFeedbackPromptContext {
  const changed = new Set(changedFiles.map(normalizeRepoPath).filter(Boolean))
  const matching = items.filter((item) => {
    if (item.kind === 'issue_comment') return true
    if (!item.path) return true
    if (changed.size === 0) return true
    return changed.has(normalizeRepoPath(item.path))
  })
  const sorted = [...matching].sort((a, b) => {
    const priority = itemPriority(a) - itemPriority(b)
    if (priority !== 0) return priority
    return itemUpdatedAt(b).localeCompare(itemUpdatedAt(a))
  })
  const included = sorted.slice(0, maxEntries)
  const omitted = Math.max(0, items.length - included.length)

  const summary = summarizePullRequestFeedbackItems(items)
  if (included.length === 0) {
    return {
      text: '',
      considered: items.length,
      included: 0,
      omitted,
      unresolvedThreads: summary.unresolvedThreads,
      resolvedThreads: summary.resolvedThreads,
      outdatedThreads: summary.outdatedThreads
    }
  }

  const lines = included.map((item) => {
    const author = item.authorLogin ? ` by ${item.authorLogin}` : ''
    return `- ${feedbackLabel(item)} (${feedbackLocation(item)}${author}): ${truncatePromptField(
      item.body
    )}`
  })

  const text = [
    '## Pull request feedback context - advisory only',
    `Aerie found ${included.length} prior PR discussion item${included.length === 1 ? '' : 's'} relevant to this review${omitted > 0 ? ` (${omitted} omitted by cap/path)` : ''}.`,
    'Use this to avoid repeating resolved or already-debated feedback and to honor explicit reviewer requests. Current source code and the current diff still win.',
    ...lines
  ].join('\n')

  return {
    text,
    considered: items.length,
    included: included.length,
    omitted,
    unresolvedThreads: summary.unresolvedThreads,
    resolvedThreads: summary.resolvedThreads,
    outdatedThreads: summary.outdatedThreads
  }
}
