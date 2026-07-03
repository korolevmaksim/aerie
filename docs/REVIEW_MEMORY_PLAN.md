# Review Memory / Evidence Ledger Plan

Status: implementation blueprint with local-ledger, context-fallback, portability, and prompt-memory slices implemented

Last updated: 2026-07-03

Implemented in the first slice:

- persisted line-insensitive `stableId` and renderer-visible finding occurrence ids;
- SQLite `review_memory_annotations` and `review_memory_events`;
- main-process annotation, soft archive, list, repo/global precedence, export/import, and
  suppression policy;
- typed IPC/preload methods that annotate by finding occurrence id, not raw stable id;
- Settings-level repo memory manager with search, filters, note/status editing, archive controls,
  selected-row bulk archive, JSON export/import, and recent audit events;
- consolidated panel findings can be annotated or archived directly from consensus,
  single-source, and suppressed rows;
- single-run GitHub confirm shows a warning when local review memory suppressed structured
  findings, so agent prose is reviewed before posting;
- LLM prompts include bounded changed-file review-memory context with explicit
  "advisory/current source wins" wording and transcript-visible counts;
- run findings, manual consensus, and panel reports match review memory by stable id;
- findings persist an optional hash-only source-context id; matching falls back to context hash
  after stable-id matching misses, without storing source snippets;
- suppressing decisions collapse repeat findings into recoverable local UI sections;
- `fixed` findings that appear again are marked reopened and remain actionable;
- `smoke:store` verifies migration, matching precedence, required notes, updates, soft archive,
  export/import, audit events, context fallback, reopened fixed repeats, note redaction, and
  suppression policy.

## Goal

Aerie should remember which findings were useful, false positive, dismissed,
accepted risk, fixed, duplicate, or still need follow-up. The memory must reduce
repeat review noise without becoming an invisible mute list or a hidden prompt
dependency.

The feature is local-first:

- stored under Aerie-owned local data, not in the reviewed repository by default;
- never sent to GitHub unless the user explicitly copies or posts it;
- never exposes tokens, raw logs, raw agent transcripts, or secret-bearing tool
  output;
- visible, reversible, and auditable from the UI;
- used as advisory context only. Current source code always wins.

## Baseline Before First Slice

Aerie already has the right foundation:

- `findings` table stores normalized structured findings per run.
- `Finding.fingerprint` exists, but it is currently a short exact dedupe key
  derived from file, line, rule, and normalized message.
- `RunView` and `PanelReportView` display persisted findings.
- Run and panel records already have local disposition:
  `open`, `handled`, `verified`.
- Panel reports already aggregate findings by location for consensus.
- Agent output and findings are redacted before persistence.
- GitHub posting is confirm-gated and redacted again at the write boundary.

Remaining larger gaps after the implemented ledger/context/portability/prompt slices:

- no known core Review Memory gap remains for the requested v1 wedge; future work can add richer
  manual rules, team sync, or bulk status edits only after real usage proves they are needed.

## External Research Takeaways

The useful industry pattern is not "hide things automatically." It is:

1. stable finding identity;
2. explicit triage status;
3. required justification for suppressions and accepted risk;
4. scope-aware matching;
5. reopen/reverse support;
6. audit/reporting visibility;
7. feedback-driven review context.

Relevant patterns:

- GitHub code scanning lets users dismiss alerts with a reason and optional
  comment, bulk dismiss matching alerts, and later reopen dismissed alerts.
- Semgrep distinguishes fixed, ignored, closed, and removed findings. Ignored
  findings can carry reasons such as false positive, acceptable risk, or no time
  to fix.
- SARIF standardizes analysis results and supports suppressions, justification,
  fingerprints, and result lifecycle concepts.
- SonarQube exposes Accepted and False positive issue statuses, comments, reopen
  flows, tags, and bulk management.
- CodeRabbit, Qodo, Bito, and Greptile all market some form of learned review
  preferences, PR-history context, path-scoped guidance, or feedback-driven
  filtering.
- reviewdog's diff filter modes show why changed-line scoping matters for
  developer trust.
- Research on static-analysis warning suppression shows that suppressions are
  often needed, but they also create risk when they are accidental, stale, too
  broad, or poorly justified.
- Recent LLM/static-analysis research supports using LLMs to reduce false
  positives, but only with evidence and cost controls.
- Cloudflare's internal AI review write-up reinforces the need for orchestration,
  specialized reviewers, deduplication, severity judgment, and structured output
  instead of one large generic prompt.

Sources:

- GitHub code scanning alert resolution:
  https://docs.github.com/en/code-security/how-tos/manage-security-alerts/manage-code-scanning-alerts/resolve-alerts
- Semgrep triage and remediation:
  https://docs.semgrep.dev/semgrep-code/triage-remediation
- SARIF 2.1.0:
  https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
- GitLab SARIF field mapping and suppression handling:
  https://docs.gitlab.com/user/application_security/detect/sarif/
- SonarQube issue management:
  https://docs.sonarsource.com/sonarqube-server/10.6/user-guide/issues/managing
- CodeRabbit learnings:
  https://docs.coderabbit.ai/knowledge-base/learnings
- CodeRabbit path instructions:
  https://docs.coderabbit.ai/configuration/path-instructions
- CodeRabbit code guidelines:
  https://docs.coderabbit.ai/knowledge-base/code-guidelines
- Qodo PR history:
  https://docs.qodo.ai/code-review/concepts/pr-history
- Bito custom review rules:
  https://docs.bito.ai/ai-code-reviews-in-git/implementing-custom-code-review-rules
- Greptile best practices:
  https://www.greptile.com/docs/code-review-bot/best-practices
- Greptile memory and learning:
  https://www.greptile.com/docs/how-greptile-works/memory-and-learning
- reviewdog filter modes:
  https://github.com/reviewdog/reviewdog
- Reducing false positives in static bug detection with LLMs:
  https://arxiv.org/html/2601.18844v1
- Rethinking code review workflows with LLM assistance:
  https://arxiv.org/html/2505.16339v1
- An empirical study of suppressed static analysis warnings:
  https://software-lab.org/publications/fse2025_suppressions.pdf
- Linux kernel developer responses to static analysis bug reports:
  https://www.usenix.org/legacy/event/usenix09/tech/full_papers/guo/guo_html/
- Cloudflare AI code review orchestration:
  https://blog.cloudflare.com/ai-code-review/

## Product Principles

1. **Finding memory is evidence, not vibes.**
   Every durable decision must point back to a finding occurrence, run, repo,
   head SHA, source, reason, and timestamp.

2. **Suppression must be visible.**
   If Aerie lowers or hides a finding because of memory, the UI must show that
   decision and make it reversible.

3. **Reasons are required for risky decisions.**
   `false_positive`, `accepted_risk`, and broad `dismissed` decisions require a
   human-entered reason. Optional guidance can explain future behavior.

4. **Scope is explicit.**
   A decision may apply to exactly one finding, the same stable issue, a
   path/rule pattern, or repo-level guidance. Broad scopes require clearer UI and
   stronger confirmation.

5. **Current code wins.**
   Memory can explain past decisions, but it must not instruct agents to ignore
   current evidence. Prompt wording must explicitly say stale memory can be
   wrong.

6. **Local-only by default.**
   Memory is not auto-posted and not committed to the reviewed repo unless a
   future explicit export action is added.

7. **Developer ergonomics beat decoration.**
   The UI should be dense, scannable, keyboard-accessible, and action-oriented:
   rows, filters, menus, reason dialogs, undo, and history. No marketing cards,
   no decorative badges, no fake IDE chrome.

## Terminology

| Term               | Meaning                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| Finding occurrence | One persisted row produced by one run from one tool or agent.              |
| Exact fingerprint  | Current exact dedupe key for one occurrence shape.                         |
| Stable finding id  | Versioned, longer identity for the same logical issue across runs.         |
| Memory annotation  | Human decision attached to a finding or matching scope.                    |
| Memory event       | Append-only audit event for annotation create/update/apply/reopen/archive. |
| Memory match       | A computed or persisted relation between a new finding and prior memory.   |
| Evidence ledger    | The observable timeline of findings, annotations, matches, and outcomes.   |
| Rollup             | Bounded human-readable summary generated from annotations.                 |

## Decision Model

Use one explicit decision field, not vague local run status:

```ts
type FindingDecision =
  | 'accepted'
  | 'fixed'
  | 'false_positive'
  | 'accepted_risk'
  | 'duplicate'
  | 'dismissed'
  | 'needs_follow_up'
```

Rules:

- `accepted`: the finding is real and should be acted on.
- `fixed`: the finding was addressed or is no longer present.
- `false_positive`: the finding is wrong; reason required.
- `accepted_risk`: real issue, intentionally allowed; reason required.
- `duplicate`: same underlying issue as another finding; link target preferred.
- `dismissed`: not useful for another reason; reason required.
- `needs_follow_up`: not decided yet, but important enough to track.

Do not overload run-level `handled` / `verified`. Those remain workflow states
for the whole run or panel. Finding decisions live at finding scope.

## Identity And Matching

The current `fingerprintOf()` is useful for exact dedupe but not enough for
review memory:

- it is only 8 hex characters;
- it changes when a line moves;
- it is too exact to match repeated agent comments that phrase the same thing
  slightly differently;
- it has no version prefix, so future algorithms are hard to migrate safely.

Add versioned IDs:

```ts
interface FindingIdentity {
  occurrenceId: number
  exactFingerprint: string
  stableId: string
  matchKeys: {
    location: string | null
    issue: string
    rule: string | null
    path: string
  }
}
```

Recommended algorithm:

- `exactFingerprint`: keep existing stored value for compatibility, but compute
  new values with a longer hash in future rows only after migration tests pass.
- `stableId`: `aerie-finding-v1:` plus SHA-256, truncated to 24 or 32 hex chars.
- `issue` key: normalized path, normalized rule id, normalized message, source
  family, but line-insensitive.
- `location` key: normalized path and line when line exists.
- `rule` key: source family plus rule id.
- `path` key: normalized repo-relative path.

Matching confidence:

| Match kind      | Confidence | Future behavior                                                                  |
| --------------- | ---------- | -------------------------------------------------------------------------------- |
| `exact`         | high       | auto-attach prior annotation; suppress only if user enabled future effect        |
| `stable_issue`  | high       | show prior decision; suppress only for exact false-positive/accepted-risk memory |
| `line_drift`    | medium     | show "similar prior finding"; do not hide by default                             |
| `path_rule`     | medium     | show path/rule guidance; do not hide by default                                  |
| `path_guidance` | low        | prompt context only; never hide UI rows                                          |
| `repo_guidance` | low        | prompt context only; never hide UI rows                                          |

Initial implementation should only auto-collapse exact and stable-issue matches
when the original annotation explicitly says it affects future reviews.

## Data Model

Add a migration after the current store version.

### Extend `findings`

Add:

```sql
ALTER TABLE findings ADD COLUMN stable_id TEXT;
ALTER TABLE findings ADD COLUMN identity_version TEXT NOT NULL DEFAULT 'legacy-fnv1a-v1';
CREATE INDEX idx_findings_stable_id ON findings (stable_id);
CREATE INDEX idx_findings_fingerprint ON findings (fingerprint);
ALTER TABLE findings ADD COLUMN context_hash TEXT;
ALTER TABLE findings ADD COLUMN context_version TEXT;
CREATE INDEX idx_findings_context_hash ON findings (context_hash);
```

Backfill `stable_id` lazily when reading old rows or eagerly in migration if a
pure migration helper is available without duplicating large TS logic in SQL.
`context_hash` is populated only when the runner can safely read a bounded text
window from the app-owned checkout before cleanup. The source snippet is never
persisted.

### `review_memory_annotations`

```sql
CREATE TABLE review_memory_annotations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id             INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  finding_id          INTEGER REFERENCES findings(id) ON DELETE SET NULL,
  run_id              INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  stable_id           TEXT NOT NULL,
  context_hash        TEXT,
  exact_fingerprint   TEXT NOT NULL,
  decision            TEXT NOT NULL CHECK (decision IN (
    'accepted',
    'fixed',
    'false_positive',
    'accepted_risk',
    'duplicate',
    'dismissed',
    'needs_follow_up'
  )),
  scope_kind          TEXT NOT NULL CHECK (scope_kind IN (
    'exact',
    'stable_issue',
    'path_rule',
    'path',
    'repo'
  )),
  path_glob           TEXT,
  tool                TEXT NOT NULL,
  rule_id             TEXT,
  severity            TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
  file                TEXT NOT NULL,
  line                INTEGER,
  message             TEXT NOT NULL,
  reason              TEXT NOT NULL,
  guidance            TEXT,
  affects_future      INTEGER NOT NULL DEFAULT 1 CHECK (affects_future IN (0, 1)),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  archived_at         TEXT,
  source_ref_type     TEXT NOT NULL,
  source_ref_id       TEXT NOT NULL,
  source_head_sha     TEXT NOT NULL
);

CREATE INDEX idx_review_memory_repo ON review_memory_annotations (repo_id, archived_at);
CREATE INDEX idx_review_memory_stable ON review_memory_annotations (repo_id, stable_id, archived_at);
CREATE INDEX idx_review_memory_context ON review_memory_annotations (repo_id, context_hash, archived_at);
CREATE INDEX idx_review_memory_scope ON review_memory_annotations (repo_id, scope_kind, archived_at);
```

`reason` is always required. For quick positive decisions, use short generated
defaults such as "Marked real by user" only after the UI shows the exact text.

### `review_memory_events`

```sql
CREATE TABLE review_memory_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  annotation_id  INTEGER NOT NULL REFERENCES review_memory_annotations(id) ON DELETE CASCADE,
  event          TEXT NOT NULL CHECK (event IN (
    'created',
    'updated',
    'matched',
    'applied',
    'reopened',
    'archived'
  )),
  finding_id     INTEGER REFERENCES findings(id) ON DELETE SET NULL,
  run_id         INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  context_hash   TEXT,
  details_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_review_memory_events_annotation ON review_memory_events (annotation_id, created_at);
CREATE INDEX idx_review_memory_events_run ON review_memory_events (run_id, created_at);
```

### `finding_memory_matches`

```sql
CREATE TABLE finding_memory_matches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id     INTEGER NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  annotation_id  INTEGER NOT NULL REFERENCES review_memory_annotations(id) ON DELETE CASCADE,
  match_kind     TEXT NOT NULL CHECK (match_kind IN (
    'exact',
    'stable_issue',
    'line_drift',
    'path_rule',
    'path_guidance',
    'repo_guidance'
  )),
  confidence     TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
  applied_action TEXT NOT NULL CHECK (applied_action IN (
    'shown',
    'collapsed',
    'prompt_context',
    'ignored'
  )),
  created_at     TEXT NOT NULL,
  UNIQUE (finding_id, annotation_id, match_kind)
);

CREATE INDEX idx_finding_memory_matches_finding ON finding_memory_matches (finding_id);
CREATE INDEX idx_finding_memory_matches_annotation ON finding_memory_matches (annotation_id);
```

This table is optional in the first slice. If time is tight, compute matches on
read and persist events only when a decision affects future behavior. The final
feature should persist matches for observability.

## Typed API

Extend `RunFinding`:

```ts
interface RunFinding {
  id: number
  tool: string
  ruleId: string | null
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  file: string
  line: number | null
  message: string
  fingerprint: string
  stableId: string
  memory: FindingMemorySummary
}
```

Add:

```ts
interface FindingMemorySummary {
  decision: FindingDecision | null
  annotationId: number | null
  reason: string | null
  guidance: string | null
  matchKind: MemoryMatchKind | null
  confidence: 'high' | 'medium' | 'low' | null
  affectsFuture: boolean
  archived: boolean
}
```

Implemented IPC namespace:

```ts
reviewMemory.annotateFinding(params)
reviewMemory.updateAnnotation(params)
reviewMemory.clearAnnotation(params) // soft-archives the annotation
reviewMemory.listRepo(repoId)
reviewMemory.listRepoEvents(repoId)
reviewMemory.exportRepo(repoId)
reviewMemory.importRepo(params)
```

Validation:

- all IDs must be positive integers;
- decisions must be enum-checked in main;
- reason must be trimmed, non-empty, and length-bounded;
- guidance must be optional and length-bounded;
- scope escalation from `exact` to broader scopes must be explicit;
- renderer cannot write arbitrary memory rows without a valid stored finding
  unless a later "manual rule" UI is added.

## Matching Engine

Create `src/main/reviewMemory.ts` as the main-process service.

Responsibilities:

- derive stable IDs and match keys from `FindingRow`;
- create annotations from stored finding rows;
- find matching annotations for new findings;
- summarize matches for renderer display;
- emit audit events;
- redact reason/guidance before persistence;
- generate bounded prompt snippets.

First safe behavior:

- show all findings by default;
- attach memory summaries where matches exist;
- collapse exact/stable false-positive matches only if `affectsFuture = true`;
- never remove a finding from the database;
- never remove a finding from exported history;
- count collapsed findings in the UI and provide "show collapsed".

Prompt behavior:

- inject only matched memory, not the full repo memory;
- cap entries by count and character length;
- include file/path scope, decision, reason, and guidance;
- include explicit instruction:
  "Review memory is advisory. Current source code wins. If memory contradicts
  code or tests, report the contradiction."

## UI Plan

### RunView

Replace the plain finding list with a compact triage table:

Columns:

- severity;
- source;
- location;
- message;
- memory state;
- actions.

Actions:

- Accept;
- False positive;
- Dismiss;
- Fixed;
- More menu: accepted risk, duplicate, needs follow-up, edit memory, archive.

Interaction rules:

- false positive, accepted risk, dismissed, and broad scopes open a reason
  dialog;
- reason dialog shows the exact annotation text before save;
- save shows silent success with Undo, not a celebratory toast;
- archived/reopened updates the row in place;
- keyboard focus returns to the action that opened the dialog;
- buttons must have hover, focus-visible, active, disabled, loading, error, and
  success states.

### Evidence Drawer

Each finding row can open a side/detail pane:

- current occurrence: run, source, file, line, rule, severity, stable id;
- evidence: tool/agent source, message, consensus count if available;
- memory: matching annotation, reason, guidance, scope, timestamp;
- history: prior occurrences and decisions;
- actions: edit, archive, reopen, copy stable id.

Keep the drawer dense and utilitarian. No nested card stacks. The reading order
is evidence first, action second, history third.

### PanelReportView

Panel reports should show memory state on consensus and single-source findings:

- "new";
- "previously accepted";
- "previously false positive";
- "accepted risk";
- "duplicate";
- "fixed before";
- "needs follow-up".

Consensus should not hide memory-conflicted findings. If two agents flag a
finding that memory says is false positive, show it as "memory conflict" rather
than silently suppressing it.

### History And Repo Memory

Add a repo-scoped memory view after the per-finding slice works:

- filters by decision, path, source, rule, confidence, active/archived;
- search by file, message, reason, guidance;
- bulk archive for stale path/rule entries;
- export markdown/JSON;
- "stale candidates" section for annotations whose files disappeared or have
  not matched in several runs.

## Observability

The user should always be able to answer:

- Why did Aerie show this finding?
- Why did Aerie collapse this finding?
- Which past decision caused that?
- Who/what created the decision?
- Can I reverse it?
- Did this memory reach the agent prompt?

Add observable counters:

- total findings;
- new findings;
- memory-matched findings;
- collapsed by memory;
- reopened findings;
- stale memory candidates;
- prompt memory entries included.

Log only non-secret metadata:

- repo id;
- run id;
- annotation id;
- finding id;
- match kind;
- decision;
- counts.

Do not log reasons or guidance unless they have already passed redaction and
are intentionally persisted.

## Security And Privacy Guardrails

- Keep all memory writes in the main process.
- Renderer receives only typed, redacted summaries.
- Redact `reason` and `guidance` before saving.
- Do not store raw logs, raw transcripts, source snippets, matched secrets, or
  GitHub tokens in memory tables.
- Do not auto-post memory to GitHub.
- Do not inject full memory into prompts.
- Do not let repo-controlled files write memory directly.
- Treat imported memory JSON as untrusted data: parse in main, enforce schema/size/count caps,
  redact notes, and never accept source finding/run ids from the payload.
- Broad memory scopes require explicit UI confirmation.
- Archived annotations remain in audit history but no longer affect future
  matching.

## Implementation Slices

### Slice 1 - Finding identity surface

Goal: make findings individually addressable.

Changes:

- extend `FindingRow` and `RunFinding` to include `id`, `fingerprint`, and
  `stableId`;
- add stable ID helper and tests;
- add store migration for `findings.stable_id` and `identity_version`;
- backfill or read-time compute stable IDs for old rows;
- update `listRunFindings()` and consensus mapping without breaking UI.

Verification:

- `npm test -- src/main/findings.test.ts src/main/aggregate.test.ts`;
- `npm run smoke:store`;
- `npm run smoke:findings`.

### Slice 2 - Annotation persistence and audit events

Goal: record reversible per-finding decisions.

Changes:

- add `review_memory_annotations`;
- add `review_memory_events`;
- add pure validation for decision, scope, reason, and guidance;
- add store helpers: create, update, archive, reopen, list by repo/run/finding;
- require reasons for false positive, accepted risk, and dismissed;
- add tests for CRUD, archival, FK behavior, and redaction.

Verification:

- focused store/unit tests;
- `npm run smoke:store`.

### Slice 3 - Typed IPC and preload bridge

Goal: expose memory safely to the renderer.

Changes:

- add channels and typed preload methods;
- enforce trusted sender, ID validation, enum validation, and length caps;
- keep all write logic in main;
- return renderer-safe memory summaries.

Verification:

- IPC unit tests where existing patterns support it;
- typecheck.

### Slice 4 - RunView triage UI

Goal: let developers annotate findings with minimal friction.

Changes:

- replace finding list with triage rows;
- add reason dialog;
- add actions for accepted, false positive, dismissed, fixed, and follow-up;
- add Undo/Reopen;
- show memory state chips with accessible labels;
- preserve existing local run disposition controls.

Verification:

- React unit tests for state transitions;
- keyboard/focus pass;
- browser screenshot at narrow and desktop widths before final UI sign-off.

### Slice 5 - Matching engine and suppression policy

Goal: reduce repeat noise without hiding evidence.

Changes:

- compute exact, stable issue, line drift, path/rule, path, and repo matches;
- attach match summaries to `RunFinding`;
- collapse only high-confidence future-affecting false positive/accepted risk
  matches;
- show "N collapsed by memory" with "show collapsed";
- persist match events for observability.

Verification:

- pure matching tests;
- UI tests for collapsed/show collapsed;
- regression tests proving unmatched findings remain visible.

### Slice 6 - Prompt memory integration

Goal: let agents use memory without making it hidden prompt state.

Changes:

- build bounded memory snippets from changed paths and active source-finding metadata;
- include explicit "advisory/current source wins" wording;
- include memory counts in run transcript/system messages;
- never include archived annotations;
- never include full repo memory;
- skip project-wide prompt memory when there is no changed-file scope.

Verification:

- prompt-building tests;
- redaction tests;
- run transcript check for memory count, not raw secrets.

### Slice 7 - Panel report integration

Goal: make consensus reports memory-aware.

Changes:

- propagate memory summaries into consensus and single-source findings;
- mark memory conflicts;
- include memory section in consolidated Markdown only when user explicitly
  includes it in the confirm modal, or keep it local-only by default.

Verification:

- panel report tests;
- GitHub post body redaction and default local-only behavior.

### Slice 8 - Repo memory view and rollups

Goal: make memory manageable over time.

Changes:

- add repo memory view in History or a dedicated Memory tab;
- filters/search/export;
- stale candidates;
- generated local markdown rollup from active annotations;
- JSON export/import in Settings, with archived rows preserved.

Verification:

- renderer tests;
- export tests;
- stale matching tests.

## Test Strategy

Unit tests:

- stable ID normalization;
- match key generation;
- decision validation;
- reason/guidance redaction;
- matching confidence;
- prompt snippet bounds;
- consensus memory conflict behavior.

Store/smoke tests:

- migration chain from empty DB;
- migration chain from a v11 findings DB if practical;
- annotation CRUD;
- archive/reopen behavior;
- FK behavior when runs/findings/repos are deleted;
- no orphaned memory matches.

Renderer tests:

- finding action menu;
- reason dialog required fields;
- Undo/Reopen;
- collapsed findings visibility;
- keyboard focus return;
- run and panel memory chips.

Manual/browser QA:

- desktop width;
- 320/375/414/768 px widths for no horizontal overflow;
- long file paths and long reasons;
- empty findings;
- many findings;
- archived annotations;
- memory conflict in panel consensus.

## Definition Of Done

The feature is done when:

- every finding has a renderer-visible occurrence id and stable id;
- user can mark findings accepted, dismissed, false positive, fixed, accepted
  risk, duplicate, or needs follow-up;
- risky decisions require reasons;
- decisions are persisted locally, reversible, and audited;
- repeat findings are matched and clearly marked;
- high-confidence repeat false positives can be collapsed, never deleted;
- collapsed findings are counted and recoverable in UI;
- prompt integration is bounded, advisory, path/match-scoped, and visible;
- panel reports show memory state and conflicts;
- repo memory can be searched, archived, exported, and imported;
- all memory content is redacted before persistence;
- GitHub posting remains confirm-gated and memory is local-only by default;
- typecheck, lint, unit tests, relevant smoke tests, and browser UI checks pass.
