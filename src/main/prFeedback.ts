import type { PullRequestFeedbackResult } from '../shared/types'
import {
  buildPullRequestFeedbackPromptContextFromItems,
  type PullRequestFeedbackPromptContext
} from './prFeedbackModel'
import { getPullRequestFeedbackResult, getRepoById, listPullRequestFeedbackItems } from './store'

function assertRepoAndPr(repoId: number, prNumber: number): void {
  if (!Number.isInteger(repoId) || repoId <= 0) throw new Error('Invalid repository id.')
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error('Invalid pull request number.')
  }
  if (!getRepoById(repoId)) throw new Error('Repository not found.')
}

export function listCachedPullRequestFeedback(
  repoId: number,
  prNumber: number
): PullRequestFeedbackResult {
  assertRepoAndPr(repoId, prNumber)
  return getPullRequestFeedbackResult(repoId, prNumber)
}

export function buildPullRequestFeedbackPromptContext(
  repoId: number,
  prNumber: number,
  changedFiles: readonly string[]
): PullRequestFeedbackPromptContext {
  assertRepoAndPr(repoId, prNumber)
  const items = listPullRequestFeedbackItems(repoId, prNumber, 300)
  return buildPullRequestFeedbackPromptContextFromItems(items, changedFiles)
}
