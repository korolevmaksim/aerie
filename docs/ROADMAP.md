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
- **Shipped (M1b quality-tool expansion):** four more `kind:'tool'` entries — `bandit` (Python SAST,
  JSON), `oxlint` (zero-config JS/TS, JSON), `yamllint` (parsable text), `actionlint` (Actions
  workflows, JSON) — each documentation-researched + adversarially flag-checked for a clean,
  offline, read-only **tree-scan** with stable exit codes; schema-verified parsers in `findings.ts`
  (`parseBandit`/`parseOxlint`/`parseYamllint`/`parseActionlint`, unit-tested) + relevance gating in
  `grounding.ts`. The grounding cap was raised above the catalog size and `GroundingResult.toolsSkipped`
  surfaces any cap-skip in the run transcript, so a relevant tool is never silently dropped (even on a
  polyglot ts+py+yml diff). oxlint's `oxlint.config.ts` execution is documented in the tool catalog's
  residual-risk note (same class as eslint.config.js).
  Deferred with concrete reasons: shellcheck/hadolint (no tree-scan), golangci-lint (toolchain +
  network), mypy/pylint (unusable unconfigured / bitmask exit), stylelint (mandatory config). The
  catalog now lists **9 quality tools**.
- **Still TODO here:** M2 makes the catalog data-driven / externally refreshable so it doesn't rot,
  plus dynamic model discovery. **Depends on:** M1.

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
- **Shipped (M2 — dynamic model discovery slice):** `agentDiscovery.ts` (electron-free, unit-tested)
  — `modelDiscovery: {kind:'command', argv, format:'lines'}` on the Agent contract (opencode wired:
  `opencode models`, offline/no-auth, `provider/model` per line); `parseModelList` (trim/dedup/drop
  banners, capped) + `discoverModels`/`discoverAllModels` reuse the hardened token-stripped
  `runToolCapture` (timeout→killTree, never-reject). **Only AUTHOR-SHIPPED descriptors run** — a
  user-added agent's probe is skipped via a `trustedIds` allowlist (exec-consent for user probes is
  M12). New async `runner:discoverAgents` channel + a **Discover models** button in the Tools tab
  caches results to `settings`; `listAgentInfos()` stays synchronous and overlays the cache over the
  seed, tagging `AgentInfo.modelsSource` `'static'|'discovered'`. Code + security review pending.
- **Shipped (M2 — data-driven catalog slice 1):** the bundled catalog is now DATA, not hardcoded
  TS. `main/data/agentCatalog.json` (schema-versioned: `schemaVersion` + `agents[]`) holds the
  existing `qwen`/`cn` entries; a new pure, electron-free `main/catalogSchema.ts` (`parseCatalog`
  / `isCatalogEntry`, unit-tested) validates a catalog payload into `Agent[]` — rejecting a wrong
  schema version, a non-array `agents`, a malformed entry, a duplicate id, or an entry without a
  `detect` binary, collecting errors and **never throwing** (one bad entry can't sink agent
  loading). `agentCatalog.ts` now loads + validates that JSON, so `AGENT_CATALOG` is the parsed
  entries. **Behavior-preserving**: byte-identical exec signatures verified, so the bundled
  entries stay author-trusted in `CANONICAL_SIGNATURES` (M12). The same parser is the chokepoint a
  user catalog and a signed-remote update will reuse — neither auto-trusted (trust is
  signature-keyed in the runner, not granted by `parseCatalog`).
- **Shipped (M2 — user catalog slice 2):** an optional `userData/agentCatalog.json` (same
  schema) is read in `loadAgents` and merged through the SAME `parseCatalog` chokepoint.
  `toAgentTemplate` now rebuilds every parsed entry from an EXPLICIT field allow-list (drops
  `__proto__`/`constructor`/unknown keys; copies optionals only when present so signatures stay
  byte-identical; `cloneModelDiscovery` keeps only a valid `command` descriptor). `mergeCatalogs`
  combines bundled + user with **bundled winning** on id collision; `parseUserCatalog` JSON-parses
  the file string and never throws; `loadUserCatalog` no-ops on a missing/unreadable file. User
  entries are NOT in `CANONICAL_SIGNATURES` → `needsConsent: true`, refused at the spawn boundary
  and excluded from discovery probes (`SHIPPED_IDS`) until consented. Pure logic unit-tested (incl.
  a no-prototype-pollution case + signature stability); the userData read is build-smoke verified.
- **Shipped (M2 — candidate detection slice 3a):** `candidateDiscovery.ts` (pure, unit-tested)
  + `listCandidates()` + a read-only `runner:listCandidates` IPC surface installed coding CLIs
  that have no configured agent as inert `AgentCandidate`s (`command`/`label`/`path` — no runnable
  template, never spawned, excludes any binary an agent already uses). Detection is a pure
  name-match of a bounded, author-curated `KNOWN_CODING_CLIS` registry (generic-collision names
  `goose`/`forge`/`q`/`amp`/`llm` deliberately excluded) against PATH file-existence — it
  **executes nothing**. Reviewed (code + security): APPROVED, inert by construction.
- **Shipped (M2 — candidates Tools-UI slice 3b):** the Tools view renders candidates in a
  read-only "Detected, not configured" section with an "Add as agent" shortcut that opens the
  agent editor prefilled with the candidate's command (via an imperative `AgentEditorHandle` —
  confirms before discarding an in-progress edit, moves focus into the form). No new privileged
  surface; nothing runs until the user saves + approves the agent. Frontend-review: APPROVED.
- **`configFile` discovery kind — DOCUMENTED-DEFER (researched 2026-06-23, no actionable
  consumer).** Checked whether qwen-code / continue (`cn`) / codex keep a user-pickable model list
  in a readable local config file: **Continue** does (`~/.continue/config.yaml`, YAML, top-level
  `models:` → per-entry `name`), but it's a non-consumer for Aerie because (a) it's YAML (a new
  parser dependency) and (b) Aerie's `cn` template has **no `--model` flag** (cn uses Continue's own
  configured model), so a discovered list would be non-actionable — a model dropdown that selects
  nothing. **qwen-code** and **codex** were not confirmed to store a selectable model list on disk
  (model passed via `--model`/env; codex's `debug models` JSON is Experimental). Shipping the
  `configFile` kind now would add a `ModelDiscovery` variant with no real consumer, so it's deferred
  until a confirmed agent exists (or Aerie wires `cn --model` + a YAML reader). The slice itself is
  small once justified: `{kind:'configFile', path, jsonPath}` + an allow-listed `cloneModelDiscovery`
  branch (read-only, never exec) + a pure file-content→`string[]` parse.
- **Still TODO (M2):** **probe enrichment** for candidates (`--version`/`--help`/config globs —
  itself local exec, so exec-consent + timeout + killTree gated); the **signed-remote** catalog update
  through `parseCatalog` (add a read size cap + signature verification before trust); and provenance
  layering.

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

#### M5 — SAST/linter grounding of the LLM review  *(shipped)*
- **Shipped (M5a):** the prompt plumbing — `renderFindingsForPrompt` + a `{{groundTruth}}`
  `buildPrompt` var that auto-appends a verifier-framed section ("confirm/refute/merge; add only
  substantiated NEW issues; do not pad") unless the prompt places it. Pure + unit-tested.
- **Shipped (M5b):** `grounding.ts` (electron-free) — `selectGroundingTools` (installed + relevant
  by changed-file extension), `runToolCapture` (spawn+capture, never-rejects, timeout→killTree,
  stderr drained), `gatherGroundTruth` (parallel, capped, parse→scope→render). `execute()` runs it
  before an LLM agent (best-effort, never blocks) and injects the result. **Opt-out** setting
  `ui.groundReviews` (Settings toggle) for untrusted repos; prompt file redacted. Code +
  **security review APPROVED** (2 rounds). Real `node`-spawn unit tests. **M5 COMPLETE.**
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
- **Shipped (M6):** `aggregate.ts` (electron-free, unit-tested) — `aggregateFindings(findings,
  {consensusMin, minSeverity})`: (1) exact dedup by `tool+fingerprint`; (2) collapse the SAME issue
  (source-agnostic key `file+line+normalized-message`) to one most-severe representative, dropping
  groups with fewer than `consensusMin` **distinct sources** (the count is over distinct tools, not
  raw occurrences — test-locked); (3) `minSeverity` floor. Returns `{kept, total, filtered, deduped,
  belowConsensus, belowSeverity, bySeverity}`. Defaults (`consensusMin=1`, `minSeverity='info'`) =
  pure dedup/collapse, non-destructive. Wired into `gatherGroundTruth`, which now filters tool
  findings before injecting `{{groundTruth}}` and returns `rawCount`; the runner's grounding line
  reports "(N filtered)". Designed so cross-AGENT consensus (M9 multi-agent runs) drops in by passing
  the agents' findings alongside the tools'. Code review **APPROVED**. **M6 COMPLETE.**
- **Deferred to M9:** persisting the aggregate + a renderer RunView "X of Y (Z filtered)" surface +
  user-configurable `consensusMin`/`minSeverity` settings — there is no multi-agent finding set to
  aggregate until the engine runs agents in parallel, so the aggregator currently applies on the
  single tool-grounding path (params, defaults off).

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
- **Shipped (M-Q):** pure `shared/quality.ts` — `assessReviewQuality(output, {kind})` →
  `{level:'ok'|'low', reasons[]}`: flags empty output, the runner's truncation marker, a too-short
  body (<40 non-ws chars), a leaked transcript (`<thinking>` or >60% tool-call/envelope lines), and
  a bare `[aerie]` sentinel; tool runs are never gated. Shared so the renderer badge AND the future
  M9 auto-post gate use one verdict. The runner emits a `⚠ low-quality review` transcript line for
  spawned LLM runs only (the empty-tree "nothing to review" short-circuit is excluded); `RunView`
  surfaces it as an amber caution above the post controls (line-anchored marker match, no false
  trigger). 12 unit tests incl. negative cases (code-block/table reviews stay `ok`). Malformed tool
  JSON already degrades to `[]` in the parsers; per-tool timeouts already exist via the agent
  contract's `timeoutSec`. Code review **APPROVED**. **M-Q COMPLETE.**

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
- **Shipped (M7):** `RefType = 'commit'|'pr'|'working-tree'`; `gitEngine.headShaOf` (read-only
  `rev-parse`) + `prepareWorkingTree` (writes `git diff HEAD` or `--staged`, mode `'working-tree'`,
  NO worktree; `cleanupCheckout` skips `worktree remove` for it). The async `runnerStart` IPC
  validates the mode, requires `user_local_path`, and resolves HEAD via `headShaOf` *before*
  `isValidSha` (renderer passes no sha). `execute()` branches: working-tree runs the agent +
  grounding with `cwd` = the user's clone (no clone/checkout, no token, no GitHub call), and a clean
  tree short-circuits with "nothing to review". DB **migration v12** rebuilds `runs` to relax the
  CHECK; `migrate()` now toggles `foreign_keys` OFF (outside the tx) so the rebuild can't cascade-
  wipe `findings` — proven by `smoke:migration`. UI: a **Working Tree** tab + mode picker
  (`WorkingTreeView`), `RunPanel` widened to `RefType`, `RunView` shows only "Create issue" for
  working-tree (no commit/PR comment). Dedup keys on the mode so staged vs all don't collide.
  Code review + **security review APPROVED**. Smokes: `smoke:worktree` (real-git read-only +
  diff semantics), `smoke:migration` (data-safe rebuild). **M7 COMPLETE.**

**Components:** `shared/types.ts`, `main/agentRunner.ts`, `main/gitEngine.ts`, `main/store.ts`
(CHECK migration), renderer RunPanel/RepoView. **Effort:** M. **Depends on:** M0, M5.

**Accept:** with uncommitted edits in a mapped clone, a working-tree run reviews exactly the working
(or `--staged`) diff and makes zero GitHub calls; never mutates the working copy; grounding (M5) and
noise-filter (M6) apply identically; clear error when no local clone is mapped.

---

### Phase 4 — Automation engine *(manual → automated)*

#### M8 — ETag-cached polling foundation  *(shipped)*
- Mirror the `listRepos` ETag pattern (`github.ts:104-130`) onto `listCommits`/`listPullRequests`
  (today none) reusing the `http_cache` table; 304 = free. Rate-limit-aware backoff reading
  `X-RateLimit-Remaining/Reset`. New `watches` state: last-seen head SHA / PR per watched repo.
  PR deltas use merge-base..head (consistent with M0).

**Shipped (M8):** `listCommits`/`listPullRequests` route through one `conditionalListPage`
helper that sends `if-none-match` and replays the cached page body on a thrown 304
(`Paginated.fromCache`), caching `{items,hasMore}`+ETag per `(account,repo,branch,page)` in the
`http_cache.payload` column (migration **v13**). New `watches` table (UNIQUE per repo+ref_type+ref,
FK→repos ON DELETE CASCADE) + store helpers (`getWatch`/`upsertWatch`/`touchWatchPolled`/
`markWatchSeen`/`listWatchesForRepo`). `pollCommitHead(account, repoId, repo, branch)` does a
1-item conditional probe → `PollResult` (`headSha`/`changed`/`fromCache`/`rate`/`nextPollDelayMs`);
a bare poll records `last_polled_at` only — `last_seen_sha` advances via `markWatchSeen` AFTER the
delta is processed (so no commit is skipped). Pure, unit-tested `rateLimit.ts`
(`parseRateLimit`/`nextPollDelayMs`: base cadence → exponential backoff as the budget shrinks →
park-until-reset when exhausted). Validation: vitest (`rateLimit.test.ts`), `smoke:watches` (real
better-sqlite3 v13 migration + helpers), build smoke. Code review APPROVED. **No write path, no
renderer surface** — the M9a poller consumes these primitives.

**Components:** `main/github.ts`, `main/store.ts`, `main/rateLimit.ts` (new), `shared/types.ts`,
`scripts/smoke-watches.cjs` (new). **Effort:** M. **Depends on:** M0.

**Accept (met):** a second `listCommits` within the window returns the 304-cached result and does
not decrement the rate budget; low remaining → exponential backoff defers the next poll; a new commit
is reported only when head SHA changes vs last-seen.

#### M9a — Pipeline engine core
**Shipped (first slice — multi-agent fan-out):** `runner:startBatch` + the pure `batch.ts`
`planBatch` (dedup + installed-only + cap 8, unit-tested) + `startBatch()` in the runner, which
starts one correlated run per eligible agent on a single ref (reusing `startRun`, bounded by the
M0 semaphore). The shared run validation + working-tree HEAD resolution was factored into one
`resolveRunTarget` IPC helper (used by both single + batch starts). A **Panel review** toggle in
`RunPanel` multi-selects installed agents and streams each agent's review side by side; an
already-running agent for the ref is skipped, not-installed/over-cap agents are reported. No new
table (a batch = runs sharing repo+sha+ref). Code + security review APPROVED.
**Shipped (structured agent output):** `buildPrompt` asks the agent to append a fenced
`aerie-findings` JSON block; pure `parseAgentFindings` (unit-tested) extracts it best-effort
(findings carry `tool = agentId`) and strips it from the prose, so the runner writes clean prose
to `.out`/the posted comment and persists the agent's findings (the M-Q gate runs on the prose).
New `runner:findings` IPC + a compact severity-tagged findings list under each review. This is the
**structured-output dependency** the fan-out flagged.
**Shipped (M9a foundation slice — model + persistence):** the pipeline data model + pure core
logic + the SQLite persistence, with the security crux landed and reviewed in isolation before any
live engine wires it. `shared/types.ts`: `Pipeline`/`PipelineDraft`/`PipelineStep`/`PipelineScope`/
`PipelineAction`/`PipelineGuardrails`/`PipelineRunSummary`. Pure, unit-tested `main/pipelineModel.ts`:
`isPipelineDraft` (validate before the engine), `matchesScope` (branch/label/author/path/draft/
maxCommits — absent = wildcard), `pipelineConfigHash` + `dedupeKey` (finished-run dedupe so the poller
never re-runs identical work), and the **auto-post gate** `mayAutoPost`/`assertMayPost`/
`effectiveAction` (a write needs `kind==='post' && autoPost===true`; a disabled post degrades to
`stage`, never posts silently). `store.ts` migration **v14**: `pipelines` (config JSON + promoted
`enabled`/`action_kind`/`auto_post` columns) + `pipeline_runs` (indexed `dedupe_key`, `posted` flag) +
CRUD/dedupe helpers + `reconcileInterruptedPipelineRuns` (crash recovery that never advances watch
state past an unprocessed delta). Validation: vitest (`pipelineModel.test.ts`, 15) + `smoke:pipelines`
(real better-sqlite3 v14 migration, CRUD, dedupe, crash recovery, CASCADE) + build smoke. Code +
security review APPROVED. **No engine/poller/IPC yet** — next slices.
**Shipped (M9a orchestration-logic slice):** pure, unit-tested `main/pipelinePlan.ts` — the engine's
brain, electron-free so it's provable before any timer/write wires it. `planWaves` resolves step
`dependsOn` into ordered parallel waves (the wait-for-all barrier ordering) with
duplicate/unknown-dep/self-dep/cycle detection. `checkGuardrails` decides eligibility in order
concurrency → per-repo cooldown → runs-per-hour (with retry-after timing). `applyJitter`/
`planNextPollAt` pace polling (reuse `nextPollDelayMs`'s rate backoff, add injected-`rand` jitter,
schedule relative to now so a wake from sleep can't catch-up-burst). `selectDuePolls` enforces the
global poll budget across many watches. Validation: vitest (`pipelinePlan.test.ts`, 17). Code review
APPROVED. **Still next:** the electron-bound `poller.ts` + `pipelines.ts` engine wiring (timers,
`startRun` per step, `runEvents.onFinished` barrier, the `assertMayPost`-gated actioner) +
teardown-on-quit + IPC — security-reviewed.
**Shipped (M9a engine-core slice):** `main/pipelines.ts` — the dependency-injected, electron-free
engine. `runPipelineForDelta(pipeline, delta, ports)` runs one pipeline through scope filter →
`planWaves`/guardrail/dedupe gates → insert a `pipeline_run` → the step waves (`startStep` +
await-all per wave = the barrier) → M6 `aggregate` → the actioner; never throws (errors mark the
run 'error' and return `{ran:false,reason:'error'}`). The **auto-post gate is enforced + unit-proven**:
the sole write port (`ports.post`) is reachable only inside the `effective==='post'` branch, which
`effectiveAction` enters only for an enabled post and which calls `assertMayPost` immediately before
the write — a disabled post degrades to stage (notify, no write). `processDelta` dispatches a delta to
every matching pipeline then advances the watch ONCE, only when none errored (a scope/guardrail/dedupe
skip counts as settled). All side effects go through `EnginePorts`, so the security flow is covered by
deterministic vitest with fakes (`pipelines.test.ts`, 14) — a disabled-post pipeline never reaches the
write port, an enabled-post writes exactly once, gates skip without running, the wave barrier orders,
and the watch only advances after clean processing. Code + security review APPROVED. **Still next:**
the live `poller.ts` timer + the real port adapter (bind `startRun`/`runEvents`/store/GitHub) +
teardown-on-quit + IPC.
**Shipped (M9a live-wiring building blocks):** the tested units the real adapter binds. Pure
`main/pipelineEngineLogic.ts` (vitest): `parsePipelineRow` (JSON-parse + `isPipelineDraft`-validate a
persisted `config` blob, overlay the row id, null on invalid — the engine validates every loaded
config before acting), `prNumberFromRef`, `splitIssueBody`, `assembleGuardrailState`. `main/runWaiter.ts`
(vitest — `runEvents` is electron-free): one `onFinished` subscription resolving per-runId promises =
the engine's `waitForRun`. Store guardrail inputs (smoke): `countActivePipelineRuns`,
`recentPipelineRunStarts`, `lastRepoPipelineRunStart`. The engine's `post` port now takes the `action`
so the adapter re-asserts `assertMayPost` independently (defense-in-depth). Validation: vitest
(`pipelineEngineLogic.test.ts` 14, `runWaiter.test.ts` 4) + `smoke:pipelines` (the guardrail queries) +
build smoke. Code review APPROVED. **Still next:** the thin electron `buildEnginePorts` glue (bind
`startRun`/`runWaiter`/`aggregateRunFindings`/the gated GitHub-writer dispatch/store), then `poller.ts`
+ teardown-on-quit, then IPC.
**Shipped (M9a live-engine-adapter slice):** `main/pipelineEngine.ts` (electron-bound) — `buildEnginePorts()`
returns the live `EnginePorts` + a `dispose` (drops the run-event subscription), binding `startStep`→
`startRun` (agent steps; PR delta→PR number, commit delta→head SHA; tool steps filtered out upstream),
`waitForRun`→`createRunWaiter().wait`, `aggregate`→`aggregateRunFindings({groupBy:'location'})`, the store
ops, `guardrailState`→`assembleGuardrailState` over the new guardrail queries, `advanceWatch`→`markWatchSeen`,
`notify`→log. The **single engine→GitHub write call site** is the pure `dispatchGithubWrite` (in
`pipelineEngineLogic.ts`): it re-asserts `assertMayPost(action)` FIRST, then routes commit→
`createCommitComment` / pr→`createPrComment` / issue→`createIssue` via `getRepoById().full_name`.
`loadEnabledPipelines()` = `listEnabledPipelineRows().map(parsePipelineRow)` filtered to valid, agent-only
pipelines. Validation: vitest (`dispatchGithubWrite` 6 cases — a disabled action calls NO writer, an
enabled one routes to exactly the right writer once) + build smoke (the adapter compiles against the real
runner/store/GitHub signatures). Code + security review APPROVED. **No poller calls the engine yet** — the
write path is wired but dormant; `poller.ts` + app-lifecycle start/stop + IPC are next.
**Shipped (M9a poller slice — the engine now runs end-to-end):** `main/poller.ts` — a single
self-rescheduling timer (`startPoller`/`stopPoller`, wired into `main/index.ts`: start after the
store + IPC are ready, stop in `before-quit`). Each tick: `loadEnabledPipelines` → `deriveWatches`
(commit-trigger pipelines watch their repo default branch; deduped) → `selectDueWatches` (global
poll budget) → `pollCommitHead` per due watch → on a changed head, `buildCommitDelta` +
`processDelta(matchingPipelines, delta, ports)`; the next poll is scheduled via `planNextPollAt`
(rate backoff + jitter). It awaits each pipeline run before re-polling that watch (no double-runs on
one head), backs off on errors, and idles cheaply when no pipelines are enabled (no watches → no
polls → no writes). Teardown clears the timer + disposes the engine ports and never starts a run
during shutdown. Pure poll-cycle logic (`pollerLogic.ts`: `deriveWatches`/`watchKey`/
`selectDueWatches`/`buildCommitDelta`/`matchingPipelines`) → vitest (9); the timer/lifecycle → build
smoke. Code + security review APPROVED. **M9a engine is functionally COMPLETE** (poll → detect →
run → ground → aggregate → gated action). **Still next:** the pipelines IPC surface + the M13
Automate UI so users can create pipelines (today none exist, so the loop idles); a PR trigger,
per-pipeline branch scoping, and real catalog/prompt-version dedupe are follow-ups.
**Shipped (M9a pipelines CRUD IPC slice):** an `isTrustedSender`-guarded surface — `pipelines:list`
(`listPipelineRows` → `toPipelineWithRuns`, each with `listPipelineRunsForPipeline`), `pipelines:save`
(`validateSaveRequest` → `isPipelineDraft`; rejects a malformed draft, a bad id, or an unknown repo;
`insertPipeline`/`updatePipeline`), `pipelines:delete`, `pipelines:setEnabled`. Channel names in
`shared/channels.ts`, the typed `aerie.pipelines.*` preload API, and `PipelineWithRuns`/
`SavePipelineRequest` types. The handlers persist config ONLY (never a GitHub write); a proposed
`autoPost:true` only persists — the engine's `assertMayPost` still gates the write — and the poller
picks up changes each tick. Pure `pipelineIpc.ts` (`validateSaveRequest`/`rowToRunSummary`/
`toPipelineWithRuns`) → vitest (10); the handlers/preload → build smoke. Code + security review
APPROVED. **Still next:** `runNow`/`dryRun` (dry-run forces stage/notify — no auto-post on a manual
run) + a `pipeline:status` push, then the M13 Automate UI.
**Shipped (M9a run-now/dry-run slice):** `isTrustedSender`-guarded `pipelines:runNow`/`pipelines:dryRun`
handlers (the renderer sends only the pipeline id; the repo + current head are resolved in main via
`getRepoById` + `pollCommitHead`). New engine `RunOptions` (`pipelines.ts`): `manual` bypasses the auto
gates (trigger/scope/guardrail/dedupe — the user explicitly ran it); `dryRun` forces `action.autoPost`
off so `effectiveAction` can never be `post` (the write branch is unreachable) and salts the run's
dedupe key so it can't suppress a real auto run. Pure `planManualRun` (`pipelineIpc.ts`) validates the
pipeline is runnable (commit trigger + known repo + default branch) → the watch spec; `DELTA_META`
moved to `pollerLogic.ts` (shared by the poller + run-now so keys match); `PipelineRunOutcome` moved to
`shared/types.ts` (the run reply). Validation: vitest — the engine `dryRun` on an enabled-post pipeline
writes NOTHING + records `action:stage` + salts the key (proven with fakes), `manual` bypasses gates +
non-dry manual run-now posts/keeps the canonical dedupe key, and 3 `planManualRun` cases; handlers/
preload → build smoke. Code + security review APPROVED.
**Run-now MAY post** for an enabled-post pipeline (documented, per the opt-in); **dry-run NEVER posts**.
**Still next:** the `pipeline:status` push (live UI updates), then the M13 Automate UI.
**Shipped (M9a pipeline:status push slice):** a `pipeline:status` main→renderer push so the Automate UI
live-updates. Electron-free `main/pipelineEvents.ts` (mirrors `runEvents`): `emitPipelineRunChange` /
`onPipelineRunChange` / `resetPipelineEvents`. The engine adapter's write ports (`insertPipelineRun`/
`updatePipelineRunStatus`/`setPipelineRunPosted` in `pipelineEngine.ts`) emit a `PipelineRunChange`
(pipelineId/runId/status/action/posted — token-free) after each store write; `main/index.ts` broadcasts
it (mirroring `onStatus`/`onOutput`); the preload exposes `aerie.pipelines.onStatus(cb)→unsub`. No new
renderer→main handler (outbound push only), so code-review only. Validation: vitest
(`pipelineEvents.test.ts`, 4 — subscribe/multi/unsub/reset); the broadcast wiring → build smoke. Code
review APPROVED. **The M9a IPC surface is COMPLETE.** **Still next:** the M13 Automate UI (the
left-nav view + pipeline list/editor/run-history), which consumes this push.
**Shipped (cross-agent consensus):** `aggregateFindings` gained `groupBy:'issue'|'location'` + a
per-finding `agreement` count; `'location'` (file+line) is the robust cross-agent mode (agents
phrase differently). `runner:consensus({runIds, consensusMin, minSeverity, groupBy})` aggregates a
panel's persisted findings; a **Consensus** section in RunPanel keeps issues ≥K agents flag at one
location, with a min-agreement selector. Pure aggregation over already-redacted local data. The
panel-review arc (fan-out → structured output → consensus) is complete.
**Still TODO (M9a):**
the wait-for-all-steps barrier + the M6 aggregator for cross-agent consensus (now unblocked by
structured agent output), the actioner (`notify|stage|post`, `auto_post` default
0, gated on M-Q), pipeline persistence (`pipelines`/`pipeline_runs`), the poller/triggers (needs
M8), and the dedupe cache. Greenfield main-process engine reusing the strongest seams.
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

> **⛔ HUMAN-GATED — design ready, build BLOCKED pending owner green-light (autonomous-loop note,
> 2026-06-23).** M9b is the one remaining feature that crosses *new trust boundaries the current
> SPEC §4 does not sanction*, so the autonomous loop is deliberately NOT building it without an
> explicit human decision. The mechanism is settled; the **product/security decisions are not**:
>
> - **(D1) Write into the user's REAL repo `.git`.** SPEC §4 today says agent runs use *app-owned
>   clones, never the user's working copies* (worktree mode is read-only, default OFF). A git-hook
>   trigger requires Aerie to **install a hook into the user's actual `.git/hooks`** — a write into
>   the user's repo that §4 currently forbids. Decision needed: extend §4 to permit a
>   hook install **behind explicit per-repo consent**, never silent, never clobbering an existing
>   hook (append a fenced `# >>> aerie >>> … # <<< aerie <<<` block, fully removable), and surfaced
>   in the repo's mapping UI with an obvious "uninstall hook" affordance.
> - **(D2) Run a local loopback listener.** A **unix-domain socket / named pipe** (chmod 0600,
>   in `userData`, **never a TCP port**), main-process only, unreachable from the renderer. The hook
>   shim presents a **per-install secret** (stored in `safeStorage`, written into the hook file with
>   0700 perms) so only Aerie's own hook can signal it; a bad/missing secret is ignored. Decision
>   needed: approve standing up this listener at all (it is new attack surface, even if loopback +
>   authed), and its lifecycle (start with the poller, stop on quit).
> - **(D3) The `gate=true` blocking semantics.** A `pre-push` shim can BLOCK the push on a critical
>   finding. Decision needed: confirm Aerie may gate a developer's push (UX: timeout/bypass escape
>   hatch so a hung review can't trap the user), and that a hook trigger still runs in the app-owned
>   clone through the SAME engine gates (`assertMayPost` etc.) — a hook MUST NOT bypass auto-post
>   consent or post on its own.
>
> **Once D1–D3 are granted**, the build slices are: **(1)** PURE, side-effect-free
> `hookScript()`/`parseHookSignal()`/`planHookInstall|Uninstall()` (generate the fenced shim,
> parse a signal → a `working-tree`/commit delta the engine understands, idempotent
> append/remove that never clobbers a foreign hook) — vitest; **(2)** the electron-bound socket
> listener + secret + fs hook-install + per-repo consent UI — smoke + build smoke + **mandatory
> security-review**. Until then M9b stays parked; the poller (M9a) already delivers automation,
> just on a poll delay rather than instantly.

#### M-Cfg — Repo-level `.aerie/` config *(missed item — on-goal)*
**[missed item]:** "flexible, shareable" configuration implies version-controlled, reviewable config,
not only SQLite rows. A `.aerie/` directory (pipeline defs, tool policy, severity thresholds, ignores,
posting policy) with local overrides, loaded into the engine, makes automation shareable across clones
and reviewable in PRs. **Effort:** M. **Depends on:** M9a.

> **Design note (autonomous-loop, 2026-06-23): a TRUST decision precedes the build.** `.aerie/`
> is repo content that *travels with the reviewed SHA*, so on a PR review the file at the PR HEAD is
> **attacker-controlled**. The parser must be allow-list/declarative-only (never an exec/command/
> path-to-run, parsed like `catalogSchema.toAgentTemplate`) AND each field needs a "can't be abused"
> ruling: a config may only ever **restrict, never widen** what runs/posts (e.g. a repo may force
> auto-post OFF, never ON). The headline `ignore`-globs consumer (git pathspec excludes on the review
> diff) has a real **review-evasion** edge — a malicious PR could ship `.aerie` with `ignore:['**']`
> to hide its own changes from the AI review — so it must be **surfaced, not silent** ("review scoped
> per .aerie: ignoring …"), and likely honored from the **base branch**, not the PR head. Settle the
> base-vs-head trust model + the restrict-only rule before building; the pure parser + the consumer
> are then a clean two-slice vertical (parser+path-match = vitest; diff wiring = smoke + security-review).

---

### Phase 5 — UI/UX gap closure *(before promotion)*

#### M11 — Accessibility & quick-win UI fixes
Global `:focus-visible`; keyboard-operable rows across Repos/Commits/Pulls/History; aria-labels on all
selects; a shared styled `ConfirmDialog` (extracted from `PostConfirmModal`, focus-trapped) replacing
native `window.confirm` (`AccountsPanel.tsx:122`); skeleton loaders (reduced-motion aware); empty states
with one CTA; success toast + persistent Posted badge; WCAG-AA contrast + non-color status glyphs;
console autoscroll-only-near-bottom + "Jump to latest". **Effort:** M. **Depends on:** M0.
- **Shipped (M11 — focus/keyboard slice):** pure `lib/focusTrap.ts` (`nextFocusIndex` wrap math +
  `FOCUSABLE_SELECTOR`, unit-tested) + a `useFocusTrap` hook (traps Tab within a dialog, restores
  focus to the opener on close); applied to the GitHub-write `PostConfirmModal` (which already had
  Esc + `role="dialog"`/`aria-modal`). Global keyboard-only `:focus-visible` ring (no outline on
  mouse click). Run status is an `aria-live="polite"` `role="status"` region.
- **Shipped (M11 — keyboard rows + labels):** `lib/a11y.ts` (`isActivationKey` + `clickableRow`,
  unit-tested) makes the commit/PR list rows (RepoView + PrDetailView) real keyboard buttons
  (focusable, role=button, Enter/Space); `aria-label`s added to the unlabelled Agent + branch
  selects.
- **Shipped (M11 — onboarding + landmarks):** a real first-run onboarding empty-state in
  `AccountsPanel` (token scopes + create link + local-encryption reassurance); the top `<nav>` is a
  labelled landmark with `aria-current="page"` on the active tab; the account/branch/token inputs
  have accessible names; the brand wordmark is keyboard-operable. (`<main>`/`<nav>` landmarks were
  already semantic.) **Still TODO:** non-color status glyphs (likely unnecessary — statuses
  already carry a text label); reduced-motion skeletons.
- **Shipped (M11 — Run-history keyboard access):** the Run-history rows were mouse-only
  (clickable `<li onClick>` with no keyboard focus/activation) and nested the "posted" link in the
  clickable area — a WCAG 2.1.1 failure. The open action is now a native `<button>` (Tab + Enter/
  Space) with the posted link a separate focusable sibling; the `<li>` keeps list-item semantics
  and the button shows a `:focus-visible` ring. Frontend-review APPROVED.
- **Shipped (M11 — commit/PR list semantics):** the RepoView + PrDetailView clickable commit/PR
  rows used `clickableRow` (role="button" ON the `<li>`, overriding its listitem role). Converted
  to the same listitem-preserving native-`<button>`-inside-`<li>` pattern, so the `<ul>` is
  announced as a list again; `clickableRow` now serves only App's standalone wordmark.
  Frontend-review APPROVED.
- **Shipped (M11 — shared ConfirmDialog):** an accessible, focus-trapped `role="alertdialog"`
  (`components/ConfirmDialog.tsx`) behind a promise-based `useConfirm()` hook
  (`lib/useConfirm.ts`), mounted once at the app root, replaces blocking/unthemed `window.confirm`
  at three async sites — `AccountsPanel` (remove account), `AgentEditor` (delete + the
  candidate "Add as agent" discard-confirm). Cancel is the autofocused default (a bare Enter
  never fires a destructive action); Escape/overlay-click cancel; danger styling on destructive
  confirms. Frontend-review APPROVED.
- **Shipped (M11 — auto-post confirm, last `window.confirm`):** `PipelineEditor`'s auto-post
  opt-in now uses the shared `useConfirm()` dialog too — **no `window.confirm` calls remain**. The
  async handler keeps the controlled checkbox unchecked until the danger confirm resolves true (no
  optimistic flip), preserving the exact gating semantics (`autoPost` can only turn on via the
  confirm; the main-process `assertMayPost` + SQL `CHECK` stay authoritative). Because the confirm
  renders over the focus-trapped editor and both have a window Escape listener, the editor guards
  its own Escape-to-close with a `confirming` flag (same-node window listeners can't be separated
  by `stopPropagation`). Security-review + frontend-review APPROVED (a first frontend pass caught a
  broken capture-phase Escape fix; reworked to the flag guard and re-approved).

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
- **Shipped (M12 — exec-consent SECURITY CORE):** pure `execConsent.ts` (`agentSignature` = sha256
  over `command+args+env+discovery-argv`; `isExecAllowed`/`agentNeedsConsent`, unit-tested). The
  runner enforces it at the **spawn boundary** in `execute()` (a non-shipped agent without matching
  consent is REFUSED — never queued or spawned — and finalized `error` with a clear message);
  `SHIPPED_AGENT_IDS` (defaults+catalog) are implicitly trusted and reuse the existing discovery
  gate. `runner:approveAgent` (main re-derives + persists the signature; renderer only names the
  id), `AgentInfo.needsConsent`, a Tools "⚠ needs approval / Approve to run" affordance, and the
  run launcher disables an unapproved agent. Slot accounting hardened so the early refusal can't
  over-release the semaphore. Code + **security review** done.
- **Shipped (M12 — editor backend):** pure `userAgents.ts` (`upsertUserAgent`/`deleteUserAgent`/
  `cloneToUserAgent`, unit-tested — rejects shipped-id collisions, malformed/duplicate ids, invalid
  payloads; supports rename) + runner `saveUserAgent`/`deleteUserAgentById`/`cloneAgentToUser` that
  read/write ONLY the user slice (`[...DEFAULT_AGENTS, ...userSlice]`, so a default is never
  shadowed/clobbered) and clean up orphaned per-id settings on rename/delete + `runner:saveAgent`/
  `deleteAgent`/`cloneAgent` IPC (each `isTrustedSender` + validated). Code + security review done.
- **Shipped (M12 — editor UI → M12 COMPLETE):** the `Agent` contract moved to `shared/types`
  (re-exported from `agentConfig`) so the renderer can edit it; `AgentInfo.editable` + a
  `runner:getAgent` IPC return the full descriptor. Pure `lib/agentForm.ts` (form ↔ Agent mapping +
  client validation, unit-tested) + an `AgentEditor` component in the Tools tab: list/add/clone/
  edit/delete user agents (full contract incl. args/env editors) with inline errors and the
  Approve-to-run consent step. Code review done. **Deferred (minor):** `setEnabled` (a per-agent
  disabled flag) + the shared `ConfirmDialog` (the editor's delete still uses `window.confirm`).

#### M13 — Automate section + pipeline editor UI  *(COMPLETE)*
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

**Shipped (M13 slice 1 — pure form↔draft logic):** `renderer/src/lib/pipelineForm.ts` (pure, unit-tested,
mirrors `agentForm.ts`): `PipelineFormState` + `blankForm`/`draftToForm`/`formToDraft(form, base?)` mapping
the editor fields (name, repo, trigger, agent steps with model + comma-split `dependsOn`, scope
[branches/paths/labels/authors CSV + includeDrafts + maxCommits], action [kind + autoPost + target], and
the three guardrails) ↔ `PipelineDraft`. Client-side validation (required name/repo/≥1 step, unique step
ids, self-/unknown-dep rejection, non-negative numeric fields); `autoPost` is dropped for any non-`post`
action so the form can never persist a stray true flag; `enabled`/`schedule` are preserved from `base` on
edit and a new pipeline defaults **disabled** (review-then-enable). Main still re-validates with
`isPipelineDraft` + the engine checks the step graph at run. Validation: vitest (`pipelineForm.test.ts`,
12 — happy path, scope/action/guardrail mapping, round-trip, and every validation branch). Code review
APPROVED. **Still next:** the Automate view + pipeline list (slice 2), the editor modal (slice 3), and the
run-history/dry-run panel (slice 4).
**Shipped (M13 slice 2 — Automate view + pipeline list):** a new `automate` view in `App.tsx` (nav tab
+ `Go to Automate` palette command) rendering `AutomatePanel.tsx` — lists each pipeline (name, repo
`owner/name`, trigger badge, an enable/disable toggle via `aerie.pipelines.setEnabled`, a live status
pill via `aerie.pipelines.onStatus`, and Run-now / Dry-run buttons via `aerie.pipelines.runNow/dryRun`
with an inline `aria-live` result); an empty state with a Create button (the editor is slice 3, stub
for now). Pure `renderer/lib/automate.ts` (`displayRunStatus` — a live push wins over listed history;
`statusLabel`/`statusTone` [text label, never color-only]; `applyLiveChange`; `describeOutcome`) →
vitest (10). The `pipelines:list` DTO gained `repoFullName` (resolved in the handler) for display. The
React view is build-smoke verified — **HUMAN visual + screen-reader sign-off pending**. No new
privileged surface (all calls go through the gated IPC) → code-review only. Code review APPROVED.
**Still next:** the editor modal (slice 3) + the run-history/dry-run panel (slice 4).
**Shipped (M13 slice 3 — pipeline editor modal):** `PipelineEditor.tsx`, a focus-trapped modal
(`useFocusTrap` + `.modal-overlay`/`.modal` + Esc, mirroring `PostConfirmModal`) driven by
`pipelineForm.ts`. Fields: name; repo `<select>` (the selected account's repos, passed from
`AutomatePanel`); trigger; a repeatable agent-step list (agent `<select>` from `runner.listAgents`,
optional model + dependsOn, add/remove, auto-assigned `s<n>` ids); scope inputs; the action radio —
**Post** reveals a target + an explicit **auto-post** toggle gated behind a distinct danger
`window.confirm`; collapsible guardrails. Save → `formToDraft(form, editing)` (inline error) →
`aerie.pipelines.save({id, draft})` → refresh. Tool-bearing pipelines are refused for edit.
`AutomatePanel` now owns the editor (Create opens blank; per-row Edit opens it) and fetches the
repos+agents picklists; `App` passes `accountId`. **No new privileged surface** — the danger confirm
is UX; the engine's `assertMayPost` is the guard. Pure logic already covered by `pipelineForm.test.ts`;
the React modal is build-smoke verified — **HUMAN visual + screen-reader sign-off pending**. Code
review APPROVED. **Still next:** slice 4 — run history + dry-run result panel.
**Shipped (M13 slice 4 — run history; M13 COMPLETE):** each pipeline row gained an expandable
**Run history** `<details>` disclosure (native — `aria-expanded` for free) listing the recent
`pipeline_runs` from `item.runs` newest-first: a status pill (tone + text label), then
`formatRunLine` (action · posted? · trigger · short SHA), then a live relative time via
`formatRelativeTime`. Pure `formatRunLine`/`shortSha` (`lib/automate.ts`) → vitest (2); the
expansion → build smoke. Code review APPROVED. **M13 — Automate section + pipeline editor UI is
COMPLETE** (form logic → list view → editor modal → run history); a pipeline is created, edited,
enabled, run/dry-run, and watched entirely from the UI, with auto-post behind the per-pipeline
danger opt-in. **Pending human sign-off:** visual + screen-reader pass over the Automate view +
editor (focus order, the long scrolling form, the action radiogroup) and a live GitHub-write dry run.

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
- **Shipped (M14 — command palette slice):** pure `lib/palette.ts` (`scoreMatch` subsequence fuzzy
  scorer with consecutive/word-boundary bonuses + `filterCommands`, unit-tested) + a focus-trapped
  `CommandPalette` overlay (role=dialog/listbox, arrow-key nav, Enter to run, Esc/overlay-click to
  close) + a global **Cmd/Ctrl-K** handler in `App` wiring view-switch, account-switch, and
  jump-to-repo (repos loaded lazily from the ETag cache on first open). Code review done.
- **Shipped (M14 — Run-history search):** a free-text search box in the Run-history header
  (`lib/runFilter.ts`, pure + unit-tested) filters the loaded runs by repo/agent/SHA/PR/status/
  author — whitespace-tokenized, token-AND, case-insensitive — composing with the existing
  per-repo dropdown; query-aware empty state. Client-side only (no IPC). Frontend-review APPROVED.
- **Shipped (M14 — Run-history export):** "Copy MD" / "Copy JSON" buttons copy the visible
  (filtered) runs to the clipboard (`lib/runExport.ts`, pure + unit-tested) — a GFM table or a
  JSON array of a SAFE field subset that excludes the local run-log path, internal ids, and any
  token; aria-live "Copied N runs" confirmation. Client-side only. Frontend-review APPROVED.
- **Shipped (M14 — poller observability):** a read-only `pipelines:pollerStatus` IPC exposes the
  poller's `{ running, lastPolledAt, nextPollAt, rate:{remaining,limit} }` (no token; no behavior
  change — pure bookkeeping in `poller.ts`); the Automate view renders a liveness line via the pure
  `lib/pollerStatus.ts` formatter (unit-tested), refreshed every 15s. Code + security review
  APPROVED.
- **Shipped (M14 — run console toolbar):** RunView gained **Copy** / **Copy MD** buttons that put
  the run's review on the clipboard (the clean captured review when finished, else the live
  transcript); the Markdown variant wraps it in a target/agent/status header via the pure,
  unit-tested `lib/runConsole.ts` (asserts no token/path injected). Client-side; frontend-review
  APPROVED.
- **Shipped (M14 — re-run):** a finished run in the history view has a **Re-run** button that
  re-launches the same agent on the same target via the already-gated `runner.start` (HistoryPanel
  owns the params + new-run selection; RunView just renders the button when a parent passes
  `onRerun`); a failed re-launch is surfaced. Frontend-review APPROVED.
- **Shipped (M14 — value-first onboarding):** the zero-accounts welcome now leads with Aerie's
  core value (runs local AI agents on a commit/PR, posts the review back) + an explicit 3-step path
  to a first review + the agent-autodetect/Tools pointer (`AccountsPanel`). Frontend-review APPROVED.
  **Still TODO (M14):** structured 2-column launcher + left-rail IA (subjective UI restructuring —
  deferred as not clearly net-positive without owner direction).

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
