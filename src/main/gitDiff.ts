// Pure planning for the review diff range — the electron-free decision the git
// engine executes. Extracted so the load-bearing correctness rule (ROADMAP M0)
// is unit-testable without git or electron.
//
// The bug this fixes: a multi-commit PR was reviewed as `sha^..sha` (only its
// head commit), so the agent saw the wrong diff on the flagship "review this PR"
// action.

/**
 * Returns the `git` argv (after the `git` executable) for the review diff.
 *
 * - PR runs (a base SHA is known): a THREE-DOT diff `base...head`, i.e. exactly
 *   what the PR adds since the merge-base of base and head — the whole PR, not
 *   just its last commit.
 * - Commit runs (no base): diff against the first parent `head^..head`.
 *
 * A root commit (no parent) has no diffable range here; the engine handles that
 * separately via `git show`. `baseSha` is ignored when falsy.
 */
export function reviewDiffArgs(headSha: string, baseSha?: string | null): string[] {
  if (baseSha) return ['diff', `${baseSha}...${headSha}`]
  return ['diff', `${headSha}^`, headSha]
}
