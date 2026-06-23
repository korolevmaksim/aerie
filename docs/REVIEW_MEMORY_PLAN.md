# Review Memory Plan

## Why

Whole-project and repeated repo reviews need local continuity. Aerie should let an agent see
prior resolved findings, false positives, accepted architecture decisions, and recurring risk
areas without making that memory a hidden prompt dependency.

The pattern matches existing review/analysis systems:

- GitHub code scanning alerts carry a dismissal state and reason such as false positive.
- Semgrep supports ignored findings with reasons such as false positive or acceptable risk.
- SARIF standardizes structured analysis results and suppression metadata.
- AI review tools such as CodeRabbit market repo/path-scoped "learnings" from review feedback.

## Product Shape

Add a repo-scoped **Review memory** layer after project reviews are stable:

```text
<userData>/review-memory/
  <account-login>/
    <owner>/
      <repo>/
        memory.md
        findings.jsonl
        decisions.jsonl
        rollups/
          2026-06.md
```

The agent prompt should include only an optional hint:

```text
Optional review memory: /.../review-memory/<account>/<owner>/<repo>/memory.md
Read it only if prior false positives, accepted decisions, or recurring issues are relevant.
```

The path is local and never posted to GitHub. The agent chooses whether to read it; Aerie does not
inject the full memory into every prompt.

## Atomic Annotations

Each structured finding in `RunView` should be individually markable:

- `valid-bug`
- `false-positive`
- `accepted-risk`
- `architecture-decision`
- `duplicate`
- `needs-follow-up`

Each annotation stores:

- finding fingerprint, file, line, severity, message, agent, run id, head SHA;
- label, short reason, optional replacement guidance;
- timestamp and repo/ref scope;
- whether it should affect future prompts.

False positives and accepted decisions should require a reason. This keeps memory usable as
evidence, not just a mute list.

## Memory Compaction

Do not let the history file grow without bound.

- Append every annotation to `findings.jsonl`.
- Keep `memory.md` as a compact, human-readable rollup generated from annotations.
- Prefer stable bullets grouped by path/module/rule:
  - "Do not flag X in `src/auth/*`; tokens are already scrubbed by `redactText`."
  - "Architecture decision: renderer never imports Node; privileged calls stay in main IPC."
- Age out stale entries when files disappear or fingerprints stop matching for several reviews.

## Prompt Integration

Project reviews should mention the memory path most prominently. Commit/PR/working-tree reviews can
mention it only when there are matching entries for the changed paths or finding fingerprints.

The prompt wording should be explicit:

- memory is advisory;
- current source always wins;
- old memory may be stale;
- if memory contradicts code, report the contradiction instead of trusting the memory.

## Guardrails

- Keep memory under app-owned `userData`, not in the reviewed repository by default.
- Never auto-post memory content.
- Do not store secrets, raw logs, or full agent transcripts in memory.
- Show the exact annotation before writing it to memory.
- Make annotations reversible/editable from History.
- Add export/import later, but default to local-only.

## Implementation Slices

1. Add structured annotation controls under each persisted finding.
2. Persist annotation JSONL and expose a read-only repo memory summary in History/Project.
3. Generate compact `memory.md` rollups.
4. Add optional `reviewMemoryPath` to project-review prompt context.
5. Add changed-path matching for commit/PR/working-tree prompts.

## References

- GitHub Docs: [Resolving code scanning alerts](https://docs.github.com/en/code-security/how-tos/manage-security-alerts/manage-code-scanning-alerts/resolve-alerts)
- GitHub Docs: [SARIF support for code scanning](https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support)
- Semgrep Docs: [Triage and remediate findings](https://docs.semgrep.dev/semgrep-code/triage-remediation)
- OASIS: [SARIF specification](https://docs.oasis-open.org/sarif/sarif/v2.0/sarif-v2.0.html)
- CodeRabbit: [AI code reviews that learn from feedback](https://coderabbit.ai/)
