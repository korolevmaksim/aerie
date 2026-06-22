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
