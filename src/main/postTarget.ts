import { isValidSha } from '../shared/validators'
import type { RunRow } from './store'

export type ResolvedPostTarget =
  | { kind: 'commitComment'; sha: string }
  | { kind: 'prComment'; prNumber: number }
  | { kind: 'issue'; title: string }

export type PostTargetInput = {
  kind: unknown
  title?: unknown
}

export type ResolvePostTargetResult =
  | { ok: true; target: ResolvedPostTarget }
  | { ok: false; error: string }

export function resolveRunPostTarget(
  run: Pick<RunRow, 'ref_type' | 'ref_id' | 'head_sha' | 'status'>,
  input: PostTargetInput
): ResolvePostTargetResult {
  if (run.status !== 'done') {
    return { ok: false, error: 'Only successful finished runs can be posted.' }
  }

  if (input.kind === 'commitComment') {
    if (run.ref_type !== 'commit') {
      return { ok: false, error: 'Commit comments can only be posted for commit runs.' }
    }
    if (!isValidSha(run.head_sha)) return { ok: false, error: 'Run has an invalid SHA.' }
    return { ok: true, target: { kind: 'commitComment', sha: run.head_sha } }
  }

  if (input.kind === 'prComment') {
    if (run.ref_type !== 'pr') {
      return { ok: false, error: 'PR comments can only be posted for pull request runs.' }
    }
    const prNumber = Number(run.ref_id)
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      return { ok: false, error: 'Run has an invalid pull request number.' }
    }
    return { ok: true, target: { kind: 'prComment', prNumber } }
  }

  if (input.kind === 'issue') {
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    if (!title) return { ok: false, error: 'An issue title is required.' }
    return { ok: true, target: { kind: 'issue', title } }
  }

  return { ok: false, error: 'Unknown post kind.' }
}
