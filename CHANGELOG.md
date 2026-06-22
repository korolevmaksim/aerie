# Changelog

All notable changes to Aerie are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Per the repo's documentation-discipline rule (`CLAUDE.md` / `AGENTS.md`), every new
feature or behavioral/architecture change is recorded under **Unreleased** in the
same change set.

## [Unreleased]

### Fixed

- PR reviews now diff the **whole PR** (three-dot `base...head`, with the base SHA
  resolved authoritatively from GitHub in the main process), not just the head commit —
  a multi-commit PR was previously reviewed as only its last commit
  (`gitDiff.ts`, `gitEngine.ts`, `github.ts`, `agentRunner.ts`).

### Added

- **Automation pipelines — live-wiring building blocks** (ROADMAP M9a): the tested units the
  real engine adapter binds next — `pipelineEngineLogic.ts` (parse + `isPipelineDraft`-validate a
  persisted pipeline config on load so a corrupt/forged blob can never reach the engine; resolve a
  PR number / issue title; assemble the guardrail snapshot), `runWaiter.ts` (bridges
  `runEvents.onFinished` to the engine's per-run `await`), and the store queries that feed the
  guardrails (`countActivePipelineRuns` / `recentPipelineRunStarts` / `lastRepoPipelineRunStart`).
  The engine's single write port now also receives the action, so the adapter can independently
  re-assert the auto-post gate (defense-in-depth — even a future engine bug can't write unless the
  adapter agrees it's an enabled post). No real GitHub binding yet (still zero write path).
- **Automation pipelines — engine core** (ROADMAP M9a): the dependency-injected, electron-free
  engine (`runPipelineForDelta` / `processDelta`) that drives a detected change through
  scope-filter → graph/guardrail/dedupe gates → the step waves (wait-for-all barrier) → the M6
  aggregator → the actioner. The auto-post discipline is enforced and unit-proven here: the
  single GitHub-write port is reachable ONLY inside the gated `post` branch, entered solely for
  an explicitly enabled post and guarded by `assertMayPost` immediately before the write — a
  disabled post degrades to stage and never writes. The watch's last-seen SHA advances only
  after every pipeline settles without an execution error (so an errored delta is retried, never
  skipped). All side effects (runner, store, GitHub writers) arrive through injected ports, so
  the security-critical flow is covered by fast deterministic vitest with fakes; the live
  poller + the real port adapter (binding `startRun`/`runEvents`/GitHub) are the next slice.
- **Automation pipelines — orchestration logic** (ROADMAP M9a): the pure, unit-tested "brain"
  the live engine/poller will run — `planWaves` (resolve step `dependsOn` into ordered
  parallel waves, the wait-for-all barrier ordering, with duplicate/unknown-dep/self-dep/cycle
  detection so an unsatisfiable plan never starts), `checkGuardrails` (concurrency cap →
  per-repo cooldown → runs-per-hour eligibility, with retry timing), and poll scheduling
  (`planNextPollAt` = rate-aware backoff + jitter, always relative to now so a wake from sleep
  can't burst; `selectDuePolls` for the global poll budget across many watches). No timers/IPC
  yet — the electron-bound poller + actioner wiring is the next slice.
- **Automation pipelines — foundation** (ROADMAP M9a): the data model + persistence for
  configurable `trigger → scope → steps → aggregate → action` pipelines (per repo), plus the
  pure, unit-tested core logic. The security crux ships here: the **auto-post gate** — the
  engine may write to GitHub only for an explicitly enabled `post` action (`autoPost===true`),
  enforced by an `assertMayPost` defense-in-depth check; a disabled `post` degrades to `stage`
  (held for the existing manual confirm), never posting silently. Also: config validation
  (`isPipelineDraft`), trigger scope-matching (branch/label/author/path/draft/maxCommits), and a
  dedupe key so a future poller never re-runs identical work on an unchanged head. New tables
  `pipelines` + `pipeline_runs` (migration v14) with crash recovery that never skips an
  unprocessed delta. No engine/poller/IPC yet — those are the next slices (`smoke:pipelines`).
- **ETag-cached polling foundation** for the upcoming automation engine (ROADMAP M8):
  `listCommits`/`listPullRequests` now cache each page's body + ETag in `http_cache` and send
  a conditional request, so an unchanged re-list returns from cache on a 304 (`fromCache`) at
  ~0 rate cost (mirrors the repo-list cache). A new `watches` table tracks the last-seen head
  SHA per repo ref, and `pollCommitHead` does a cheap 1-item conditional probe reporting whether
  the head moved since it was last *processed* — never advancing the last-seen SHA on a bare
  poll, so no commit is skipped. A pure, unit-tested rate-limit backoff (`rateLimit.ts`) widens
  the poll cadence as the GitHub budget shrinks and parks until reset when exhausted. Main-only
  plumbing — no GitHub writes, no renderer surface (migration v13; `smoke:watches`).
- Concurrency cap on agent runs (`semaphore.ts`, default 3) so a burst — or future
  automation — can't spawn unbounded clone+agent processes; a queued run waits for a slot.
- Reusable electron-free `whichOnPath`/`isOnPath` PATH lookup (`pathLookup.ts`), the seam
  for the upcoming broad tool autodiscovery, replacing the inline check in the runner.
- macOS GUI-launch PATH fix (`osPath.ts`): the app augments PATH with well-known install
  dirs at startup, so agent CLIs installed via Homebrew/cargo/npm/bun are detected in a
  packaged (Finder-launched) build instead of reading as "not installed".
- A read-only **Tools** tab inventorying the agent CLIs Aerie auto-detects on your machine
  (status, resolved path, capabilities, re-scan); `AgentInfo` now carries the resolved `path`.
- Broad agent-CLI detection catalog (`agentCatalog.ts`): CLIs beyond the verified 10 are
  surfaced automatically when found on PATH (never persisted to `agents.json`, never shadowing
  a default/user agent). Ships **qwen** (Qwen Code) and **cn** (Continue CLI),
  documentation-researched and adversarially flag-checked (both enforced read-only). `whichOnPath`
  now matches only regular files (not a same-named directory) and resolves Windows `.exe`/`.cmd`
  suffixes.

- Local **code-quality tools as deterministic agents** (`toolCatalog.ts`, `kind:'tool'`):
  `gitleaks`, `ruff`, `eslint`, `biome`, and `tsc` are auto-detected on PATH and run 100%
  locally (no network), emitting machine-readable findings. The agent contract gains
  `successExitCodes` so a linter that exits non-zero *with findings* is recorded `done`, not
  `error`. (Foundation for grounding the LLM review on deterministic findings.)

- Tool runs now produce **structured findings**: a `kind:'tool'` run's output is normalized into a
  common `Finding` (tool/ruleId/severity/file/line/message + a stable dedup fingerprint), scoped to
  the diff's changed lines, and persisted per run (new `findings` table). gitleaks findings never
  carry the matched secret value. Foundation for grounding the LLM review and filtering noise.

- Run output written to disk (and therefore any posted comment) is now **secret-scrubbed**:
  GitHub tokens always, plus the secret values a `gitleaks` tool run surfaces — so secrets never
  persist to `runs/*.out`/`*.log` or leak into a GitHub comment.
- New `{{changedFiles}}` review-prompt variable (the files the change touches), and a "Changed
  files" line in the machine context Aerie prepends to every prompt.

- AI reviews are now **grounded in local-tool findings**: before an agent reviews a change,
  Aerie runs your installed, change-relevant linters/scanners (eslint/ruff/biome/tsc/gitleaks),
  scopes their findings to the diff, and gives them to the agent as ground truth to confirm,
  refute, or merge — so it triages real findings instead of inventing noise. Best-effort (never
  blocks a review) and 100% local. Toggle off in Settings → "Ground reviews with local tools".

- Grounding findings now pass through a **noise filter** (`aggregate.ts`): exact duplicates are
  dropped, the same issue flagged at one location is collapsed to a single most-severe entry, and
  optional cross-source **consensus** (keep only issues ≥K distinct tools agree on) and a
  **minimum-severity** floor are supported. The grounding line reports "(N filtered)" so you see
  how much noise was removed. Pure + unit-tested; built so multi-agent consensus (future parallel
  runs) reuses the same aggregator.

- **Command palette** — press **Cmd/Ctrl-K** for a quick switcher: fuzzy-filter to jump to any view
  (Repos/History/Tools/Accounts/Settings), switch account, or open any of your repos by name. Arrow
  keys move the selection, Enter runs it, Esc closes; the overlay is focus-trapped with a listbox for
  screen readers. The fuzzy ranking is pure + unit-tested.

- **In-app agent editor** — the Tools tab now has a **Your agents** editor: add, clone a built-in,
  edit, and delete your own agents with the full contract (command, args, prompt delivery, output
  capture, timeout, kind, env), with inline validation and a one-click **Approve** for the
  exec-consent step. Saves operate ONLY on the user slice of `agents.json` — the file is always
  rewritten as `[defaults, …user agents]`, a user id can never collide with or shadow a built-in
  (default/catalog/tool) id, and the payload is validated in main. A new agent can't run until you
  approve its command, so the editor can't bypass the trust boundary. (The `Agent` contract moved to
  shared types so the editor and runner agree on the shape; `runner:getAgent`/`saveAgent`/
  `deleteAgent`/`cloneAgent` IPC.)

- **Exec-consent for user-added agents (security)** — Aerie now refuses to spawn a user-authored
  or user-edited agent (one whose id isn't a shipped template/catalog entry) until you explicitly
  **approve its command**. Approval records a signature over the agent's `command + args + env +
  model-discovery argv`; editing any of those re-requires approval, so a changed command can never
  run on stale consent. The check is enforced in the main process at the spawn boundary (never the
  renderer); shipped agents stay implicitly trusted. The Tools tab shows "⚠ needs approval" with an
  **Approve to run** button, and an unapproved agent can't be launched from the run screen.

- **First-run onboarding + nav landmarks** — with no accounts, the Accounts panel now shows a
  proper welcome explaining the token to add (classic PAT, `repo` scope, `read:org` for orgs), a
  link to create one, and a reassurance that tokens are encrypted and stay local. The top nav is a
  labelled landmark, the active tab carries `aria-current="page"`, the account/branch/token controls
  all have accessible names, and the brand wordmark is now keyboard-operable.

- **Accessibility — keyboard-operable lists & labelled controls** — the commit and pull-request
  rows (repo view + a PR's commits) are now real keyboard controls: focusable, `role="button"`,
  and activated with Enter/Space (not just mouse). Bare `<select>`s that lacked an accessible name
  (the Agent pickers, the branch filter) gained `aria-label`s, so a screen reader announces what
  each one controls. Shared `clickableRow`/`isActivationKey` helpers (pure + unit-tested). (Rows
  with nested links — History, repo favorites — are deferred for a structural pass.)

- **Accessibility — keyboard focus** — the GitHub-write confirm dialog now **traps Tab focus**
  (you can't tab out into the background) and **restores focus** to the button you opened it from
  on close, alongside its existing Esc-to-cancel and `role="dialog"`/`aria-modal`. A global
  keyboard-only focus ring (`:focus-visible`) makes Tab navigation traceable everywhere without
  showing an outline on mouse clicks. Run status is now an `aria-live` region so screen readers
  announce when a review finishes. The focus-trap wrap math is pure + unit-tested.

- **Cross-agent consensus** — in a panel review of 2+ agents, a **Consensus** section aggregates
  every agent's structured findings and shows the issues that **≥K of the agents agree on**.
  Because different agents word the same problem differently, consensus is computed by **code
  location** (file + line), not message text — the noise-filter aggregator (M6) gained a `groupBy`
  mode and now reports a per-issue agreement count. New `runner:consensus` IPC. Pick the minimum
  agreement (≥2…N) and compute after the reviews finish.

- **Structured agent findings** — review prompts now ask the agent to append a fenced
  `aerie-findings` JSON block (file/line/severity/ruleId/message). Aerie parses it best-effort,
  persists the findings per run (alongside the existing tool findings), and shows a compact,
  severity-tagged list under each review. The block is **stripped from the posted comment** so it
  stays clean prose, and the quality gate now assesses that prose. Absent or malformed block →
  prose-only, the run never fails. This is the structured-output foundation for cross-agent
  consensus (aggregating findings across a panel of agents). New `runner:findings` IPC.

- **Panel review (multi-agent fan-out)** — the first slice of the automation engine: a "Panel
  review" toggle on the run launcher lets you pick several installed agents and review one
  change with all of them at once. Each agent starts as its own correlated run (shared
  repo+sha+ref, its own saved model) and streams side by side; concurrency stays bounded by the
  run semaphore (up to 3 at a time, the rest queue). Not-installed / over-cap (max 8) agents are
  reported, not started; an agent already running for the ref is skipped. New `runner:startBatch`
  IPC; every per-run guarantee is unchanged (no GitHub token in any agent env; posting still
  behind the explicit confirm). Foundation for configurable pipelines (aggregation/consensus and
  the actioner come next).

- **Live model discovery** — the Tools tab gained a **Discover models** button that runs each
  installed agent's model-list probe (currently `opencode models`, offline + no-auth) and overlays
  the discovered model ids on the static seed, so the picker shows what you can *actually* select
  (tagged "live"). Discovery is async and spawn-based; the synchronous agent list never spawns.
  Only **author-shipped** probes run — a model-discovery command on a user-added agent is never
  executed (that needs explicit exec-consent, a later milestone). A failed/empty probe keeps the
  seed list. Pluggable per-CLI descriptors make adding another CLI's discovery a data change.

- **Broader quality-tool autodiscovery** — four more local, network-free, read-only tools are
  auto-detected on PATH and run as grounding when relevant: **Bandit** (Python SAST), **oxlint**
  (fast JS/TS lint), **yamllint** (YAML), and **actionlint** (GitHub Actions workflows). Each was
  documentation-researched and flag-checked for a clean headless tree-scan with machine-readable
  output and stable exit codes; schema-verified parsers normalize them into the common finding
  shape. The grounding tool cap rose above the catalog size and any cap-skip is now reported in the
  run transcript, so a relevant tool is never *silently* dropped (even on a polyglot diff).
  (Deferred with reasons: shellcheck/hadolint — no tree scan; golangci-lint — needs the toolchain +
  network; mypy/pylint — unusable unconfigured; stylelint — mandatory config; semgrep — network.)

- **Agent-output reliability gate** — a finished LLM review is now checked for being a *real*
  review, not just a zero exit code: empty output, output truncated mid-stream, a leaked
  reasoning/tool-call transcript, a too-short body, or a bare Aerie error sentinel are flagged
  **low-quality** with an amber caution in the run view (so you check before posting). Pure +
  unit-tested (`shared/quality.ts`); the same verdict will gate auto-posting once automation lands.
  Tool runs aren't gated here (malformed tool JSON already degrades to "no findings" without
  failing the run). The deliberate "nothing to review" outcome (clean working tree) is not flagged.

- **Working-tree review (a pre-PR pass)** — a new **Working Tree** tab reviews the uncommitted
  changes in your mapped local clone with any local agent: all uncommitted tracked changes
  (`git diff HEAD`) or only what's staged (`git diff --staged`). It makes **zero GitHub calls**,
  creates no checkout/worktree, and never mutates your working copy (read-only `git diff`/
  `rev-parse` only); the agent runs in your clone since the changes exist only there. Grounding
  (local-tool findings) and the noise filter apply identically. A clean tree short-circuits with
  "nothing to review" instead of spawning an agent. Hard-requires a mapped local clone; the run
  screen offers "Create issue" (no commit/PR comment, since there's nothing on GitHub yet).
  New `ref_type: 'working-tree'` (DB migration v12 relaxes the `runs.ref_type` CHECK; the rebuild
  preserves all rows and findings). Two new headless smokes (`smoke:worktree`, `smoke:migration`).

### Changed

- Removed the retired `dummy` agent from the documentation (`SPEC.md`, `PROMPT.md`,
  `README.md`, `CLAUDE.md`, `AGENTS.md`); the runner pipeline is now described as
  exercised by the stage smoke tests against the real, auto-detected agent templates.
  The `dummy` retirement mechanism in code (`RETIRED_AGENT_IDS`) is unchanged.

### Added

- Documentation-discipline standing rule in `CLAUDE.md` and `AGENTS.md`: every
  feature/change must be reflected in local docs (README / SPEC / this changelog) in
  the same change set; docs are part of "done".
- `docs/ROADMAP.md` — the critic-hardened build plan toward the free-OSS,
  automation-first, comprehensive-autodiscovery goal (no monetization).

## [0.1.0]

- Initial public release.
