# Aerie — Roadmap

> Build plan toward the goal: a **free, open-source, 100%-local** tool that becomes
> indispensable by maximizing utilization of the developer's **own installed tools** —
> comprehensive autodiscovery, structured-finding quality grounding, and configurable
> **automation** pipelines. No monetization, no team/SSO. Close all functionality and
> UI/UX gaps before promotion.
>
> This roadmap is the working plan; `SPEC.md` remains the architectural source of truth.
> It was produced by a multi-agent research + planning pass and hardened against an
> independent feasibility-vs-code review and a goal-alignment review. Milestone scope
> notes marked **[correction]** reflect those reviews against the actual code.

## Non-negotiable constraints (apply to every milestone)

- **100% local.** Agents/tools run on the user's machine against an app-owned clone (or
  the opt-in read-only user worktree). Source never leaves the machine. No model hosting,
  no LLM API calls by Aerie itself, no always-on server (the git-hook bridge is a
  main-only loopback IPC shim, never a TCP port).
- **Token isolation.** The GitHub token lives only in the main process, encrypted via
  `safeStorage`; it is never passed to the renderer, never placed in any agent / tool /
  discovery child env, and never written to a log. **Every new spawn site re-asserts this.**
- **Writes behind confirm.** Every GitHub write is gated by an explicit confirm. For
  automation, **auto-post is a hard per-pipeline opt-in** (default = notify/stage), enforced
  in the **main process** (defense-in-depth), not just shown in the renderer.
- **Agent-agnostic.** Adding/detecting a tool is data/config, not a code change.
- **Smallest change** that satisfies the milestone; extend existing seams.

## Pillars

1. **Foundations & Trust** — correctness, packaging/notarization, runtime safety, a11y.
2. **Comprehensive Tool Autodiscovery** — detect *all* popular agent CLIs + quality tools
   + their models, **data-driven and self-maintaining**, surfaced as a first-class Tools view.
3. **Structured Findings & Quality Grounding** — structured severity-tagged findings;
   deterministic linters/SAST as zero-cost grounding that kills LLM false-positive noise.
4. **Automation Engine** — configurable `watch → run → ground → filter → act` pipelines;
   notify/stage by default; auto-post a hard opt-in.
5. **UI/UX & Onboarding** — left-rail IA with Tools + Automate, command palette, structured
   launcher, onboarding; close every UI/UX gap before promotion.

---

## Phased plan (critic-hardened, re-sequenced by dependency)

### Phase 0 — Foundations & correctness

#### M0 — Correctness & runner foundations
Fix the load-bearing defects before anything lands on top of them.

- **PR diff range → three-dot `base...head`** for multi-commit PRs (was `sha^..sha` for
  *both* commit and PR refs, so a multi-commit PR was reviewed as only its head commit).
  **Implemented main-process-only:** the runner resolves the PR base SHA **authoritatively
  from GitHub** (`getPullRequestBaseSha`), never from renderer-supplied data, and passes it to
  the git engine, which writes a three-dot `base...head` diff (falling back to first-parent if
  the base is unreachable). Commit refs keep `sha^..sha`. The pure diff-range decision is
  extracted to `gitDiff.ts` (unit-tested). No change to `StartRunParams` / the IPC contract /
  the renderer — a smaller, non-spoofable surface than threading `base` through the renderer.
- **Concurrency semaphore** (`MAX_CONCURRENT_RUNS`) in the runner — there was no cap
  (`startRun`→`execute` via `setImmediate`); a queued run now waits for a slot. Extracted to a
  reusable electron-free `semaphore.ts` (unit-tested); the automation engine (M9) reuses it.
- **Extract `whichOnPath(bin)`** from the inline PATH walk in `isInstalled()` into an
  electron-free `pathLookup.ts` (unit-tested) — the seam M1 builds on.
- *App-clone GC moved to Phase 4 (M9a)* — it pairs with the automation engine, which is what
  multiplies clones; worktree/diff GC already exists as a startup wipe (`gitEngine.ts:216`).
- **Docs:** `dummy` already stripped from docs (done). Reconcile `SPEC.md`/`README` scope &
  positioning language with the clarified goal (org-dashboard residue, "webhooks/workflow
  dashboard out of scope", "unsigned build acceptable", the "run **any** local agent"
  overstatement — it ships 10 templates). *(Follow-up doc commit.)*

**Components (implemented):** new electron-free `main/pathLookup.ts`, `main/semaphore.ts`,
`main/gitDiff.ts` (+ vitest tests); `main/github.ts` (`getPullRequestBaseSha`),
`main/gitEngine.ts` (three-dot diff), `main/agentRunner.ts` (PR base resolution, semaphore,
`isOnPath`). **Effort:** M. **Depends on:** —.

**Accept:**
- A multi-commit PR diffs `base...head` (the whole PR), not just the head commit; commit refs
  still diff `sha^..sha` (unit test on `reviewDiffArgs`).
- Launching N+1 runs with cap N leaves exactly N active and 1 queued; the queued run starts
  when a slot frees (semaphore test).
- `grep dummy` in docs returns nothing; in code only `RETIRED_AGENT_IDS` + its tests.
- typecheck + lint + tests green.

#### M10a — Signing/notarization/update-channel skeleton *(pulled early — [correction])*
**[correction]:** release-trust infra does not depend on the pipeline UI and should land early
so every later build is shippable and testably trusted. The verified state: the app **is**
signed but with an `Apple Development` cert (device-only; `spctl` = rejected); `notarize:false`,
`publish:null`; `better_sqlite3.node` **is** already `asar.unpacked`. So the real work is:
Developer ID Application cert + `notarize:true` + staple, an update/publish channel, and
verifying the `allow-unsigned-executable-memory` entitlement survives notarization (drop it
if Electron 42 no longer needs it). **Effort:** M. **Depends on:** —.

**Accept:** a downloaded build passes `spctl --assess` (notarized, stapled), not device-only;
an update is delivered through the configured channel end-to-end (or a documented dry-run).

---

### Phase 1 — Comprehensive tool autodiscovery *(the owner's #1, previously under-delivered — front-loaded and made visible immediately)*

#### M1 — macOS PATH fix + read-only Tools inventory  *(shipped)*
The autodiscovery foundation, made correct and visible.
- **Fix macOS GUI-launch truncated PATH** — an app launched from Finder/launchd inherits a
  truncated PATH, so Homebrew/cargo/npm/bun tools read as missing. `augmentedPath` (pure,
  electron-free, unit-tested in `osPath.ts`) appends well-known install dirs that exist and
  aren't already present (existing entries keep precedence); wired at startup before any tool
  lookup. (Windows unchanged; `.exe`/`.cmd` suffix handling deferred to M1b.)
- **Read-only Tools inventory** (`ToolsPanel`, a new "Tools" tab) — lists every detected agent
  CLI with available state, the resolved binary path (`AgentInfo.path`), and capability counts,
  with a Re-scan button. Reuses the existing `runner.listAgents` IPC (no new surface). Makes
  autodiscovery a first-class, visible artifact.

**Components:** `main/osPath.ts` (+test), `main/agentRunner.ts` (`listAgentInfos` resolves path),
`shared/types.ts` (`AgentInfo.path`), `main/index.ts` (PATH aug at startup),
`renderer/components/ToolsPanel.tsx` + `App.tsx` (Tools tab). **Depends on:** M0.

**Accept (met):** a tool installed via Homebrew is detected `available:true` in a Finder-launched
app; the Tools tab lists installed vs not-installed agents with their resolved paths and re-scans live.

#### M1b — Broad agent-CLI catalog  *(partly shipped)*
A detection catalog (`agentCatalog.ts`) of agent CLIs BEYOND the verified 10, materialized into the
`loadAgents()` chokepoint via the pure `mergeAgents` (surfaced only when the CLI is on PATH, never
persisted, never shadowing a default/user id). `whichOnPath` hardened: regular-file match only (no
same-named directory) + Windows `.exe`/`.cmd`/`.bat` suffixes.
- **Shipped (2, documentation-researched + adversarially flag-checked):** `qwen` (Qwen Code —
  enforced read-only `--approval-mode plan`, clean `--output-format text`) and `cn` (Continue CLI —
  `-p --readonly --silent`).
- **Deferred (researched, not added — reason):** `crush` (`crush run` blocks on interactive
  tool-approval headless — no working skip flag, `--yolo` rejected on `run`, so it hangs to timeout);
  `amp` (no per-run read-only + paid execute, low confidence); `aider` (no clean-output flag —
  banner/cost mixed into stdout); `goose` (read-only `chat` mode disables all tools, can't open the
  diff); `llm`/`sgpt` (non-agentic — can't read the file-based diff under the current contract);
  `plandex`/`openhands`/`forge` (no headless review mode).
- **Still TODO here:** local quality tools (linters/SAST/type-checkers) as `kind:'tool'` entries; and
  M2 makes the catalog data-driven / externally refreshable so it doesn't rot. **Depends on:** M1.

#### M2 — Genuinely data-driven, self-maintaining catalog + dynamic model discovery
**[correction — this is THE fix so autodiscovery doesn't rot like before]:** a hardcoded
per-CLI enumerator roster is just a longer static list. Make it data-driven:
- **External catalog**: bundled JSON/YAML (schema-versioned: detect probe, version probe,
  model probe, parser, `successExitCodes`, safety defaults) + a **user catalog** + an optional
  **signed remote catalog update** + repo-level `.aerie/` overrides.
- **Generic probes first** (`--version`, `--help` parse, known config-file globs, npm/pip/brew
  metadata) so an unknown-but-installed coding CLI is surfaced as a **candidate** with no template.
- **Dynamic model discovery** in a separate async service (`agentDiscovery.ts`): a `modelDiscovery`
  descriptor per template — `{kind:'command', argv, parse}` | `{kind:'configFile', path, jsonPath}`
  | `{kind:'static'}`. Runs with **token-stripped env** + timeout/`killTree`, caches to the
  `settings` K/V table. **`listAgentInfos()` stays synchronous** (no spawns on the sync path);
  discovery runs only via a new async `runner:discoverAgents` channel and overlays discovered
  models on the static seed (seed = fallback), tagging `modelsSource`.
- **Model provenance** layered: CLI self-report → local config → external provider metadata sync
  (models.dev / OpenRouter-style) → static fallback, each tagged. Non-enumerable CLIs
  (amp/copilot/crush/sgpt/goose) flagged honest free-text.
- **"Unknown installed CLI candidate" report** + a catalog-freshness check in the Tools UI.
- **[correction]:** a `modelDiscovery.argv` enumerator is itself arbitrary local exec — gate
  newly-authored discovery commands behind the same exec-consent as the command (M12), with a
  hard timeout + `killTree`, and assert no token in the probe env.

**Components:** `main/agentDiscovery.ts` (new), catalog files, `main/agentRunner.ts`,
`shared/types.ts` (AgentInfo `version`/`modelsSource`), `shared/channels.ts` + `main/ipc.ts`
+ `preload/index.ts` (`runner:discoverAgents`). **Effort:** L. **Depends on:** M1.

**Accept:** with opencode installed, `runner:discoverAgents` returns its live model list
(`modelsSource:'discovered'`) overlaid on the seed; discovery failing/empty keeps the static
seed; discovery spawns inherit the token-stripped env (asserted); `listAgentInfos()` stays
synchronous; an unknown installed coding CLI surfaces as a candidate; non-enumerable CLIs show
honest free-text entry.

#### M3 — Quality tools as deterministic agents  *(shipped)*
- **Contract** (`agentConfig.ts`): `Agent` gains optional `kind:'agent'|'tool'` and
  `successExitCodes`. The pure, tested `runStatusForExit` records a tool that exits non-zero ON
  FINDINGS as `'done'`, not `'error'` (timeout still wins; default `[0]` is behavior-preserving).
- **`toolCatalog.ts`** (`TOOL_CATALOG`, `kind:'tool'`): 5 verified, **100%-local, network-free,
  fixed-tree-scan** tools — `gitleaks`, `ruff`, `eslint`, `biome`, `tsc` — surfaced via the same
  `loadAgents` → `mergeAgents` detection (on PATH only, never persisted). Documentation-researched
  + adversarially flag-checked; emit machine-readable findings to stdout.
- **Deferred (researched):** `semgrep`/`osv-scanner` (network by default), `golangci-lint`/`mypy`/
  `pyright` (flags/exit-codes failed verification), `shellcheck`/`hadolint` (need per-file targets
  — lands with M4's changed-files). Repo-signal gating (auto-select per repo) + per-repo
  `node_modules/.bin` detection are **M5/follow-up**; for now a tool is a pickable agent when on PATH.

**Accept (met):** a linter exiting non-zero on findings is `'done'` not `'error'`
(`runStatusForExit` unit tests); all 5 shipped tools are network-free; a detected tool flows
through the unchanged runner (`kind:'tool'`, no runner-path divergence); catalog guard tests pass.

---

### Phase 2 — Structured findings & quality grounding *(the differentiator)*

#### M4 — Structured-finding capture (keystone) + provenance + output redaction  *(shipped)*
- **Shipped (M4a/b):** pure `findings.ts` — the common `Finding` shape (tool/ruleId/severity/file/line/
  message/fingerprint), a stable `fingerprintOf` dedup key, **all five parsers** (eslint, gitleaks,
  ruff, biome, tsc) verified against real / schema-checked output (gitleaks deliberately **drops the
  matched secret value**), severity normalization, and diff-scoping (`parseChangedLineRanges`/
  `scopeToChanges`, abs↔relative path match). All unit-tested (incl. a secret-exclusion test).
  **Shipped (M4c):** v11 `findings` table (FK-cascades with the run; severity CHECK) +
  `insertFindings`/`listFindingsForRun`; the runner `finalize` now parses a `kind:'tool'` run's
  output → scopes to the diff → persists structured findings (best-effort, never breaks a run);
  real-SQLite Electron smoke (`smoke:findings`). Path-match anchored on a segment boundary.
  Code-review APPROVED. **Shipped (M4c-β):** `redactText`/`extractSecrets` scrub GitHub tokens AND
  gitleaks-surfaced secret values from on-disk `runs/*.out|*.log` before write (so a posted comment
  can't leak them); new `{{changedFiles}}` prompt var + machine-context line. Code + security review
  APPROVED. **M4 COMPLETE** (103 unit tests + `smoke:findings`).
- Normalize tool JSON/SARIF and agent output to a common shape and **persist** it per run
  (new migration appended to `MIGRATIONS`, `store.ts:157`) alongside the existing raw text.
- **[correction — richer provenance]:** carry `tool id+version`, exact command, exit code,
  parser used, a **stable fingerprint** (for dedupe across runs/SHAs), confidence, raw-artifact
  path — grounding (M5), consensus (M6) and finished-run dedupe all depend on it.
- **Scope to the change**: drop findings outside changed-line ranges (parse diff hunks once,
  using the **M0-corrected merge-base diff** for PRs), cap top-N by severity.
- **[missed item — must add: OUTPUT REDACTION]:** `redact()` is wired only into the logger
  (`logger.ts:26`); `runs/*.out`, `runs/*.log` and findings are written **raw**. Redact agent/tool
  outputs **before storage and before any post** — an auto-posting pipeline could otherwise publish
  a secret an agent/linter echoed. New `{{changedFiles}}` template var.

**Components:** `main/agentRunner.ts` (capture/finalize), `main/gitEngine.ts` (changed-line ranges,
`{{changedFiles}}`), `main/store.ts` (findings migration), `shared/types.ts` (Finding shape),
`main/redact.ts`. **Effort:** L. **Depends on:** M0, M3.

**Accept:** a semgrep run produces structured Finding rows (severity/file/line + provenance),
persisted and retrievable, raw stdout still available; findings outside the diff's changed ranges
are dropped; finding count capped at N; a secret echoed into output is redacted before storage; a
run with no parseable findings completes with zero findings, no error.

#### M5 — SAST/linter grounding of the LLM review  *(in progress)*
- **Shipped (M5a):** the prompt plumbing — `renderFindingsForPrompt` (severity-ordered compact
  block) + a `{{groundTruth}}` `buildPrompt` var that auto-appends a verifier-framed section
  ("confirm/refute/merge; add only substantiated NEW issues; do not pad") unless the prompt places
  it. Pure + unit-tested. **Next (M5b):** the pre-run tool phase in `execute()` (run relevant
  installed tools → scope → `renderFindingsForPrompt` → pass as `groundTruth`) + smoke + review.
- Pre-tools phase in `execute()` before `buildPrompt`: run enabled+installed+repo-relevant
  grounding tools, capture JSON, inject a fenced **`{{groundTruth}}`** block with verifier framing
  (confirm/refute/merge/rank; add only substantiated new issues) so the LLM triages rather than
  hallucinates.
- Diff-native scoping (`semgrep --baseline-commit`, `golangci-lint --new-from-rev`,
  `gitleaks --log-opts`) using `{{baseSha}}`/`{{headSha}}` — **correct only after M0** sets
  `baseSha = merge-base` for PRs.
- Graceful skip if a grounding tool is absent; no network, no token in any child env.

**Components:** `main/agentRunner.ts`, `main/agentConfig.ts` (`buildPrompt` vars), tool catalog.
**Effort:** M. **Depends on:** M0, M4.

**Accept:** a grounded run injects a `{{groundTruth}}` block with scoped findings + verifier
framing (captured prompt shows it); grounding runs only when repo-relevant; no network/token added;
the run still succeeds if a grounding tool is missing.

#### M6 — Noise filter: dedup, consensus, severity threshold
- Pure aggregator over the stored Finding shape (no re-run): dedupe (file/line/ruleId/normalized
  message + the M4 fingerprint), `consensusMin` (≥K agreeing sources), `minSeverity` threshold.
  Reused by both manual multi-agent runs and pipelines.
- **[correction]:** the **wait-for-all-parallel-steps barrier** before aggregation is owned by
  the engine (M9), since `runEvents.onFinished` fires per-run. Correlation key = `repoId+headSha+refId`.

**Components:** `main/aggregate.ts` (new), `main/store.ts`, `shared/types.ts`, renderer RunView.
**Effort:** M. **Depends on:** M4, M5.

**Accept:** two agents reporting the same file/line/rule yield one deduped finding; a single-source
finding is dropped at `consensusMin=2`; below-`minSeverity` excluded with an "X filtered of Y" count;
the aggregator is pure over stored findings.

#### M-Q — Agent-output reliability gates *(missed item — must add before any stage/auto-post)*
**[missed item]:** today `exit 0 → done` (`agentRunner.ts:419`) with no check the output is a real
review. An agent can exit 0 with empty/garbage/truncated/transcript-leaked output and, once M9
enables auto-post, publish it. Add: empty-output detection, transcript/garbage heuristics,
truncation status surfaced, per-tool timeout profiles, malformed JSON/SARIF handling. **Effort:** M.
**Depends on:** M4. **Accept:** an empty/garbage/truncated run is flagged "low-quality" and is
**ineligible** for stage/auto-post; malformed tool JSON degrades to text without failing the run.

---

### Phase 3 — Working-tree pre-PR review *(activation wedge)*

#### M7 — Review the local working tree before the PR
- New `refType: 'working-tree'`: review `git diff` / `git diff --staged` of the user's mapped
  clone, **zero GitHub calls**, never mutating the working copy.
- **[correction — understated]:** needs a migration relaxing the `runs.ref_type` CHECK
  (`store.ts:84` allows only `'commit'`/`'pr'`), a widened union + IPC validation, and
  synthetic-`sha` handling past `isValidSha` (`ipc.ts:501`). Uncommitted changes exist only in the
  user's own clone, so this **hard-requires a mapped local path** (read-only posture); clear error
  if none. Diff via `git diff [--staged]` against `repo.user_local_path` without a worktree/checkout.

**Components:** `shared/types.ts`, `main/agentRunner.ts`, `main/gitEngine.ts`, `main/store.ts`
(CHECK migration), renderer RunPanel/RepoView. **Effort:** M. **Depends on:** M0, M5.

**Accept:** with uncommitted edits in a mapped clone, a working-tree run reviews exactly the working
(or `--staged`) diff and makes zero GitHub calls; never mutates the working copy; grounding (M5) and
noise-filter (M6) apply identically; clear error when no local clone is mapped.

---

### Phase 4 — Automation engine *(manual → automated)*

#### M8 — ETag-cached polling foundation
- Mirror the `listRepos` ETag pattern (`github.ts:104-130`) onto `listCommits`/`listPullRequests`
  (today none) reusing the `http_cache` table; 304 = free. Rate-limit-aware backoff reading
  `X-RateLimit-Remaining/Reset`. New `watches` state: last-seen head SHA / PR per watched repo.
  PR deltas use merge-base..head (consistent with M0).

**Components:** `main/github.ts`, `main/store.ts`. **Effort:** M. **Depends on:** M0.

**Accept:** a second `listCommits` within the window returns the 304-cached result and does not
decrement the rate budget; low remaining → exponential backoff defers the next poll; a new commit is
reported only when head SHA changes vs last-seen.

#### M9a — Pipeline engine core
Greenfield main-process engine reusing the strongest seams.
- `pipelines.ts` (CRUD + orchestration, subscribes to `runEvents.onFinished`) + `poller.ts`
  (timer + ETag delta detection). Triggers: **commit, pr, schedule, manual**. The engine calls the
  renderer-free `startRun()` per step (keystone reuse), chains via `onFinished`, **owns the
  wait-for-all-steps barrier**, then runs the M6 aggregator, then the actioner.
- Pipeline model: `trigger → scope filter (branches/labels/authors/paths/drafts/maxCommits) →
  prepare (app-clone) → steps[] (agent + tool, parallel, optional dependsOn) → aggregate → action`.
- **Action policy:** `notify | stage | post`; **`auto_post` defaults 0**; the engine may reach
  `createCommitComment/PrComment/Issue` **only** when `auto_post===1`, with a **defense-in-depth
  assertion** that an unset flag can never post. The human `github:post` confirm path is untouched.
- Guardrails: `maxConcurrentRuns` (M0 semaphore), `perRepoCooldownSeconds`, `maxRunsPerHour`.
- New migration: `pipelines` + `pipeline_runs`; IPC `pipelines:list/save/delete/setEnabled/runNow/
  dryRun` + `pipeline:status` push, each `isTrustedSender`-guarded; start/stop with app lifecycle.
- **[missed items — must add]:** **finished-run result dedupe/cache** keyed by repo + base/head +
  tool/catalog version + prompt hash + config hash (else the poller re-runs identical work every
  cycle); **pipeline teardown on quit** (stop timers/poller, don't fire a scheduled `startRun` during
  shutdown); **`pipeline_runs` crash recovery** (mark interrupted runs failed/resumable; don't advance
  last-seen-SHA past unprocessed deltas); **poller wake/sleep/offline** handling (jitter, no catch-up
  burst); **global poll budget** across many watches.

**Components:** `main/pipelines.ts` + `main/poller.ts` (new), `main/store.ts`, `main/agentRunner.ts`,
`main/github.ts`, `main/runEvents.ts`, `shared/channels.ts` + `main/ipc.ts` + `preload/index.ts`,
`main/index.ts`. **Effort:** L (large). **Depends on:** M6, M-Q, M8.

**Accept:** a `pr` pipeline on a new head SHA runs the configured agents+tools and produces an
aggregated result with `action=notify` (no GitHub write); `auto_post` unset/0 **never** reaches a
write path (defense-in-depth assertion test); guardrails hold (cap/cooldown/maxRunsPerHour); an
unchanged SHA is not re-run (dedupe cache); quit during a run leaves no orphaned scheduled fire; a
crashed pipeline run is reconciled and no delta is skipped.

#### M9b — Git-hook trigger + working-tree trigger *(security-sensitive — own milestone)*
**[correction — split out of M9]:** a `pre-push`/`pre-commit` shim talks to a **main-only loopback
IPC listener** (named pipe / unix socket, **never a TCP port**), unreachable from the renderer, with
its own auth; blocks the push only when `gate=true`. Adds the `working-tree` trigger (M7). Gated by an
inline security-review. **Effort:** M–L. **Depends on:** M9a, M7.

**Accept:** the git-hook bridge is loopback-only and unreachable from the renderer / not a TCP port;
a `gate=true` pre-push pipeline blocks the push on a critical finding and passes otherwise.

#### M-Cfg — Repo-level `.aerie/` config *(missed item — on-goal)*
**[missed item]:** "flexible, shareable" configuration implies version-controlled, reviewable config,
not only SQLite rows. A `.aerie/` directory (pipeline defs, tool policy, severity thresholds, ignores,
posting policy) with local overrides, loaded into the engine, makes automation shareable across clones
and reviewable in PRs. **Effort:** M. **Depends on:** M9a.

---

### Phase 5 — UI/UX gap closure *(before promotion)*

#### M11 — Accessibility & quick-win UI fixes
Global `:focus-visible`; keyboard-operable rows across Repos/Commits/Pulls/History; aria-labels on all
selects; a shared styled `ConfirmDialog` (extracted from `PostConfirmModal`, focus-trapped) replacing
native `window.confirm` (`AccountsPanel.tsx:122`); skeleton loaders (reduced-motion aware); empty states
with one CTA; success toast + persistent Posted badge; WCAG-AA contrast + non-color status glyphs;
console autoscroll-only-near-bottom + "Jump to latest". **Effort:** M. **Depends on:** M0.

#### M12 — In-app registry editor + **main-enforced** exec-consent
- In-app Agents editor: `runner:saveAgent/deleteAgent/cloneAgent/setAgentEnabled` (each
  `isTrustedSender` + `isValidId` + `isAgent`); `saveUserAgents()` updates **only** the user slice,
  never clobbering `DEFAULT_AGENTS`; disable via a settings flag (no `isAgent` change).
- **[correction — #1 red flag — exec-consent must be MAIN-ENFORCED]:** an Agent is `command+args`
  spawned with the user's full env (`agentRunner.ts:351`). The `github:post` pattern (renderer confirm,
  main trusts) is acceptable for posts but **wrong** for arbitrary exec — the threat is a compromised
  renderer, and `isTrustedSender` (`security.ts:42`) only proves same-frame origin. **Store a per-agent
  consent record in main** keyed to a hash of `command+args`; `startRun` **refuses to spawn** a
  user-authored agent whose current hash isn't consented. The renderer modal only collects consent
  (shows the exact argv). Inline security-review here. The exec-consent gate must **precede** broad
  quality-tool execution (linters run repo-local configs/plugins too). **Effort:** L. **Depends on:**
  M2, M3, M11.

#### M13 — Automate section + pipeline editor UI
No-code linear `Watch → Run → Ground → Filter → Act` stepper reusing presets/prompts/agent picklists;
an Action card (radio Notify / Stage / Post) with **Post behind a distinct danger-styled per-pipeline
opt-in**, default Notify; a prominent **Run-now (dry-run)** showing what *would* happen without acting;
honest poll-cadence labels (no webhook pretense).
- **[correction]:** "add automation prefs to the `SettingKey` allowlist" is impossible as written —
  `settings:get/set` is **boolean-only** (`UI_SETTING_DEFAULTS: Record<SettingKey,boolean>`, `ipc.ts:677`;
  `settingsSet` rejects non-boolean, `ipc.ts:670`). **Scalar** prefs (cadence/cooldown/`maxRunsPerHour`)
  live in the per-pipeline JSON row (preferred) or a new typed numeric channel; only boolean global prefs
  may join the allowlist. The UI Post toggle maps to the row's `auto_post`; the **M9a engine assertion is
  the real guard**. **Effort:** L. **Depends on:** M9a, M11.

#### M14 — Command palette, structured launcher, console, IA polish & onboarding
Command palette (Cmd+K) + keyboard model; structured 2-column run launcher (labeled fields replacing the
unlabeled select row; installed agents grouped first; a configure affordance instead of a dead disabled
Start); console toolbar (Copy/Wrap/Jump/raw-review) + autoscroll-pause; **Runs** (renamed History) with
text search + status filter + export (JSON/markdown) + active-runs strip; left-rail IA
(Repos/Runs/Automate/Tools/Settings) with pinned account switcher + palette; **value-first skippable
onboarding** (Welcome → Connect account → **detected-tools reveal** → land on populated Repos), `ui.onboarded`
flag, replay from Settings; **poller observability** (last/next poll, ETag hit/miss, rate-limit, why a run
did/didn't fire) + **notification-fatigue controls** (batching, quiet hours, don't-notify-same-fingerprint).
**Effort:** L. **Depends on:** M11, M12, M13.

---

### Phase 6 — Promotion gate

#### M10b — Final security-review gate *(independent of UI — [correction])*
A consolidated security-review (plus the inline reviews at M9b and M12) covering: main-enforced
exec-consent, the git-hook loopback, the auto-post gate, and **token-leak re-verification across every
new spawn site** (discovery M2, grounding M5, pipeline children M9) + `redact.ts` coverage of any new
logged argv. No Critical findings before promotion; Warnings fixed or explicitly risk-accepted. Confirm
the notarized Developer ID build (M10a) and update channel. **Depends on:** M9b, M12, M13.

---

## Cross-cutting requirements (apply across milestones — surfaced by review)

- **Output reliability** before any stage/auto-post (M-Q): exit 0 ≠ good review.
- **Output/finding redaction** before storage and before any post (M4): `redact()` is logger-only today.
- **Finished-run dedupe/cache** (M9a): the poller must not re-run identical work on an unchanged SHA.
- **Repo-level `.aerie/` config** (M-Cfg): shareable, reviewable, version-controlled automation.
- **Per-spawn token-isolation assertion** in tests at every new spawn site (discovery, grounding, pipeline).
- **Engine resilience** (M9a): wake/sleep/offline, teardown-on-quit, `pipeline_runs` crash recovery, global poll budget.
- **Observability + anti-spam** (M14): tunable automation needs visible state and notification batching.

## Sequencing rationale

1. **M0 / M10a** first — correctness + a trusted build under everything.
2. **M1 → M2 → M3** — broad detection, then *data-driven* dynamic discovery, then quality tools; the
   under-delivered priority, made **visible from M1**.
3. **M3+M4 → M5 → M6 (+ M-Q)** — structured findings are the keystone; grounding and the noise-filter
   consume them; reliability gates precede any unattended posting.
4. **M7** — working-tree wedge, after grounding so it ships high-signal.
5. **M8 → M9a → M9b (+ M-Cfg)** — cheap polling before the engine; engine core before the
   security-sensitive git-hook bridge.
6. **M11 → M12 → M13 → M14** — a11y first, then Tools editor, then Automate UI, then palette/onboarding.
7. **M10b** — consolidated security-review gates promotion, decoupled from UI polish.

## Out of scope (explicitly dropped)

Monetization / paid tier / pricing; team / SSO / org-admin / enterprise / compliance edition;
real-time webhooks or any always-on server (git-hook bridge is local-loopback IPC); the `dummy` agent
as a shipped feature (retired in code; only stale doc refs removed); GitHub writes beyond commit/PR
comments + optional issue; Actions/workflow dashboard, activity analytics; cloud/remote agent execution;
a full node-canvas pipeline builder (v1 uses a linear stepper); TruffleHog live verification / trivy
DB-update (network — pinned off); auto-posting by default (always a per-pipeline opt-in).
