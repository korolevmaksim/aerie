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
