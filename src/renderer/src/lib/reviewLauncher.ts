import type { Prompt, RefType } from '@shared/types'

export interface ReviewTargetCopy {
  eyebrow: string
  title: string
  detail: string
  meta: string[]
}

function shortSha(sha?: string): string {
  return sha ? sha.slice(0, 8) : 'resolved at launch'
}

export function copyForTarget(refType: RefType, refId: string, sha?: string): ReviewTargetCopy {
  if (refType === 'pr') {
    return {
      eyebrow: 'Pull request',
      title: `PR #${refId}`,
      detail: 'Whole PR diff with local checkout context.',
      meta: [`Head ${shortSha(sha)}`, 'Posts back to PR']
    }
  }
  if (refType === 'working-tree') {
    const staged = refId === 'staged'
    return {
      eyebrow: 'Working tree',
      title: staged ? 'Staged changes' : 'Uncommitted changes',
      detail: staged
        ? 'Reads git diff --staged in your mapped clone.'
        : 'Reads git diff HEAD in your mapped clone.',
      meta: ['Read-only local clone', 'Issue-only posting']
    }
  }
  if (refType === 'project') {
    return {
      eyebrow: 'Project',
      title: `Repository audit on ${refId}`,
      detail: 'Full checkout plus bounded project inventory.',
      meta: [`Head ${shortSha(sha)}`, 'Issue-only posting']
    }
  }
  return {
    eyebrow: 'Commit',
    title: `Commit ${shortSha(sha)}`,
    detail: 'Single commit diff with surrounding repository context.',
    meta: ['Patch scope', 'Posts back to commit']
  }
}

export function defaultPromptId(refType: RefType, prompts: Prompt[]): number | null {
  if (refType === 'project') {
    const projectPrompt = prompts.find((p) => p.name === 'Project audit')
    if (projectPrompt) return projectPrompt.id
  }
  return prompts[0]?.id ?? null
}
