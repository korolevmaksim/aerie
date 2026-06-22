# Aerie — Build Specification (coding-agent execution prompt)

> Personal GitHub mission-control desktop app with local AI-agent orchestration.
> This document is BOTH the spec and the prompt for the coding agent.
> Execute stage by stage. Each stage is independently runnable and testable.
> Do not jump ahead. Commit at the end of each stage and STOP for human review.

---

## 1. What we are building

A desktop app (its own window) that gives one operator a unified view across
multiple GitHub accounts/orgs, and — the point of the whole thing — lets him
trigger his **local AI coding agents** (Codex, Agy, Kimi, Claude Code, any CLI)
on a specific commit or PR, with the repository checked out locally so the agent
has full context, then post the agent's review back to GitHub as a comment.

The differentiated value is the **agent-orchestration loop**, not re-rendering
GitHub's own UI. Build that loop first. Everything else is secondary.

## 2. Priorities (in strict order)

1. Reliability — it must work the same way every time.
2. Cross-platform consistency with minimal packaging pain.
3. Speed — perceived speed = caching + smart API use, not backend language.
4. Maintainability for an agent-driven owner who does not read the code by hand.

## 3. Tech stack (fixed — do not substitute silently)

- **Electron + TypeScript**, scaffolded with **electron-vite**.
- **Renderer:** React + Vite. Styling minimal (Tailwind or plain CSS). No heavy
  design system in v1.
- **GitHub:** Octokit (`@octokit/rest`, `@octokit/graphql`). GraphQL for batched
  list reads where it saves rate limit; REST for writes.
- **Local DB / cache:** SQLite via `better-sqlite3` (run `electron-rebuild` for
  the Electron ABI; if it fights the toolchain, fall back to `libsql`).
- **Git ops:** system `git` driven through `simple-git`. Never reimplement git
  in JS.
- **Secrets:** Electron `safeStorage` (OS keychain) for GitHub tokens. Tokens
  live only in the main process.
- **Packaging:** `electron-builder`, macOS target first (unsigned is fine for
  personal use; signing/notarization only matters if distributed later).

If any fixed choice blocks you, STOP and flag it. Do not swap it on your own.

## 4. Security model (non-negotiable)

- `contextIsolation: true`, `nodeIntegration: false`, sandbox where possible.
- All GitHub / git / agent / token operations run in the **main** process. The
  renderer reaches them only through a typed `contextBridge` API in preload.
- Tokens: encrypt at rest with `safeStorage`; never pass a raw token to the
  renderer; never write a token to a log.
- Any GitHub **write** (post comment, create issue) requires an explicit in-app
  confirmation step before it fires.
- Agent runs operate on **app-owned clones** (see §6), never on the user's
  personal working copies — unless he explicitly opts a repo into read-only
  worktree mode.
- **Exec-consent (ROADMAP M12).** Spawning an agent runs its `command` — for an
  author-shipped template/catalog id that's vetted, but a **user-authored or
  user-edited** agent (in `agents.json`, or via the in-app editor) is arbitrary local
  code. The runner refuses to spawn such an agent at the **spawn boundary in main**
  unless the user has recorded explicit consent for its exact command: a persisted
  `sha256` signature over `command + args + env + model-discovery argv`. Editing any of
  those re-keys the signature, so stale consent never auto-approves a changed command.
  Shipped ids are implicitly trusted (and `mergeAgents` keeps default ids authoritative,
  so a user can't shadow one to smuggle a command). The renderer only names an id to
  approve — main re-derives and stores the signature; it can never fabricate consent.
  Model-discovery probes are already gated to shipped ids (M2). `AgentInfo.needsConsent`
  surfaces the state; an unapproved agent can't be launched from the UI and is refused
  if reached anyway.
- **In-app agent editor (ROADMAP M12).** `runner:saveAgent`/`deleteAgent`/`cloneAgent`
  edit only the **user slice** of `agents.json` — the file is always rewritten as
  `[...DEFAULT_AGENTS, ...userSlice]`, so a save can never shadow or clobber a default,
  and a user id may not collide with any shipped (default/catalog/tool) id. Main
  validates every payload (`isAgent` + id rules); the renderer can't write the file
  directly. A saved agent is still subject to exec-consent above, so the editor is not an
  exec-bypass.

## 5. Architecture

```
main/        Node side — no UI
  auth        token storage (safeStorage) + per-account Octokit factory
  github      repo/commit/PR reads (cache + ETag) and writes (comments/issues)
  gitEngine   ensureClone, fetch, checkoutSha (isolated worktree), diff
  agentRunner load agent registry, prepare context, spawn, stream, capture, persist
  store       SQLite + schema migrations
  ipc         typed IPC handlers
preload/      contextBridge: exposes a typed window.api surface only
renderer/     React UI — calls window.api.*, never touches Node/tokens
```

## 6. Repo mapping & local execution

Each repo carries: `remote_url` (from GitHub), optional `user_local_path` (his
existing clone), and `app_clone_path` (app-managed, default).

- **Default run mode:** the app keeps its own clone under
  `<userData>/aerie/clones/<account>/<repo>`. `ensureClone` clones if absent,
  otherwise fetches. For a run it checks out the target SHA into a clean,
  isolated worktree. This gives the agent full repo context without touching the
  user's dev checkouts.
- **Opt-in mode:** if `user_local_path` is set and the user enables it, run via
  `git worktree add` off that clone (read-only intent), so the agent sees his
  exact local state. **Default OFF.**

## 7. Agent contract (this is what makes it agnostic)

An agent is an external CLI described in an editable config file `agents.json`
(in `userData`). The app knows nothing hard-coded about any specific agent.

Contract:
1. The app checks the repo out at the target SHA into a working dir (`cwd`).
2. The app writes a **prompt file** (review instructions + commit/PR metadata)
   and a **diff file** into a temp dir.
3. The app runs the configured command in `cwd`, passing the prompt via the
   declared channel.
4. The agent writes its review to stdout (default) or to a declared output file.
5. Exit code `0` = success. The app enforces a timeout and can kill the process.

`agents.json` entry shape:

```json
{
  "id": "codex",
  "label": "OpenAI Codex CLI",
  "command": "codex",
  "args": ["exec", "--cd", "{{repoPath}}", "{{prompt}}"],
  "promptDelivery": "arg",
  "promptPlaceholder": "{{prompt}}",
  "outputCapture": "stdout",
  "outputFile": null,
  "timeoutSec": 600,
  "env": {}
}
```

`promptDelivery` ∈ `arg | stdin | file`. `outputCapture` ∈ `stdout | file`.
Placeholders the runner substitutes: `{{repoPath}}`, `{{promptFile}}`,
`{{diffFile}}`, `{{baseSha}}`, `{{headSha}}`, `{{prompt}}`.

Ship real reference entries (e.g. **`codex`**, **`claude-code`**), auto-detected on
PATH; the runner pipeline is exercised by the stage smoke test, so it is testable
with no real agent installed.

Adding Agy / Kimi / Claude Code = editing `agents.json`. No code change. Ever.

## 8. Data model (SQLite)

```
accounts(id, label, kind['user'|'org'], login, token_blob, created_at)
repos(id, account_id, full_name, default_branch, remote_url,
      user_local_path, app_clone_path, last_synced_at)
runs(id, repo_id, ref_type['commit'|'pr'|'working-tree'], ref_id, head_sha, agent_id,
     status['queued'|'running'|'done'|'error'|'killed'],
     exit_code, started_at, finished_at, output_path, posted_url)
http_cache(key, etag, payload, updated_at)   -- conditional-request (ETag) cache; payload
                                             -- holds the body to replay on a 304 (M8)
watches(id, repo_id, ref_type['commit'|'pr'], ref, last_seen_sha, last_polled_at)  -- M8
pipelines(id, repo_id, name, trigger['commit'|'pr'|'schedule'|'manual'], enabled,
          action_kind['notify'|'stage'|'post'], auto_post, config, created_at, updated_at)  -- M9a
pipeline_runs(id, pipeline_id, trigger, ref_type, ref, head_sha,
              status['pending'|'running'|'done'|'error'|'skipped'], action, posted,
              dedupe_key, started_at, finished_at)  -- M9a
settings(key, value)
```

> **Working-tree reviews (ROADMAP M7).** A `ref_type` of `'working-tree'` reviews the
> **uncommitted** changes in the user's mapped local clone — `ref_id` selects the diff
> (`'working-tree'` = `git diff HEAD`, `'staged'` = `git diff --staged`) and `head_sha` is
> the commit those changes sit on. This path makes **zero GitHub calls**, creates **no
> worktree/checkout**, and never mutates the working copy (only read-only `git diff` /
> `rev-parse` run). It hard-requires a mapped local clone (the changes exist only there),
> so the agent — and the grounding tools (M5) — run with `cwd` = the user's clone; this is
> a deliberate, gated extension of §4 (a mapped clone + an explicit working-tree review is
> the consent), narrower than the `use_local_worktree` checkout mode. Grounding still
> honours the `ui.groundReviews` opt-out. Findings noise-filtering (M6) applies identically.

> **Automation pipelines — foundation (ROADMAP M9a).** A pipeline is a configurable
> `trigger → scope filter → steps → aggregate → action` automation, persisted per repo. The
> authored config (`PipelineDraft`: trigger/schedule/scope/steps/action/guardrails) is the
> source of truth, stored as JSON in `pipelines.config`; `enabled`, `action_kind`, and
> `auto_post` are PROMOTED to columns (derived on every write) for cheap querying and a
> SQL-level auto-post guard. Pure, unit-tested `pipelineModel.ts` holds the security-critical
> logic: `isPipelineDraft` (validate before anything reaches the engine), `matchesScope`
> (branch/label/author/path/draft/maxCommits — absent predicate = wildcard), `dedupeKey` +
> `pipelineConfigHash` (so the poller never re-runs identical work on an unchanged head), and
> the **auto-post gate** — `mayAutoPost`/`assertMayPost`/`effectiveAction`. Per SPEC §10
> auto-post is a HARD per-pipeline opt-in: the engine may reach a GitHub write ONLY when
> `action.kind==='post'` AND `action.autoPost===true`; `assertMayPost` throws otherwise (a
> defense-in-depth check called immediately before any write), and a disabled `post` degrades
> to `stage` (the prepared result is held for the existing manual confirm — never posted
> silently). The **in-code gate is authoritative**: the engine parses `config`, re-validates it
> with `isPipelineDraft`, and calls `assertMayPost` on the parsed `action` before any write; the
> promoted `auto_post` column (with its `CHECK (auto_post = 0 OR action_kind = 'post')`) is a
> belt-and-suspenders filter, never the sole guard. `pipeline_runs` records each execution with
> its `dedupe_key` (indexed), the action
> actually taken, and a `posted` flag; `reconcileInterruptedPipelineRuns` flips any
> pending/running row to `error` on startup WITHOUT advancing watch state, so an interrupted
> delta is re-detected and never skipped. The pure orchestration logic also lands here, in
> `pipelinePlan.ts`: `planWaves` (resolve step `dependsOn` into ordered parallel waves — the
> wait-for-all barrier ordering — rejecting duplicate/unknown-dep/self-dep/cycle; this is the
> sole dependency-graph validator, so the engine MUST check `planWaves(steps).ok` before
> starting a run), `checkGuardrails`
> (concurrency → cooldown → runs-per-hour eligibility), and poll pacing (`planNextPollAt` =
> rate backoff + jitter relative to now so a sleep-wake can't catch-up-burst; `selectDuePolls`
> for a global poll budget). The electron-bound wiring — the live poller, `onFinished`
> step-chaining/barrier, the M6 aggregator, the `assertMayPost`-gated actioner, and the IPC
> surface — is the next M9a slice.

> **Automation pipelines — engine core (ROADMAP M9a).** `pipelines.ts` is the dependency-injected,
> electron-free engine. `runPipelineForDelta(pipeline, delta, ports)` drives one pipeline:
> trigger/scope filter (`matchesScope`) → `planWaves`/`checkGuardrails`/dedupe gates → insert a
> `pipeline_run` → run the step waves (`ports.startStep` then await-all per wave = the wait-for-all
> barrier) → M6 `aggregate` → the actioner. It never throws — a failure marks the run `error` and
> returns `{ran:false,reason:'error'}`. The **auto-post gate** is the structural crux: the sole
> GitHub-write port (`ports.post`) is reachable ONLY inside the `effective==='post'` branch, which
> `effectiveAction` enters only for an enabled post and which calls `assertMayPost` immediately
> before the write — a disabled post degrades to `stage` (notify, no write), and the human
> `github:post` confirm path is a different code path. `processDelta` dispatches a delta to every
> matching pipeline, then advances the watch (`advanceWatch` → `markWatchSeen`) ONCE and only when no
> pipeline ended in an execution error (a scope/guardrail/dedupe skip counts as settled), so an
> unprocessed delta is never skipped past. Every side effect (runner, store, GitHub writers) arrives
> through `EnginePorts`, so the security flow is proven by deterministic vitest with fakes; the live
> `poller.ts` timer and the real port adapter (binding `startRun`/`runEvents`/store/GitHub) are next.
> The tested building blocks for that adapter are `pipelineEngineLogic.ts` (`parsePipelineRow` —
> JSON-parse + `isPipelineDraft`-validate every persisted `config` blob before the engine acts on it,
> so a corrupt/forged row is rejected — plus PR-number/issue-title/guardrail-state helpers) and
> `runWaiter.ts` (one `onFinished` subscription = the engine's per-run `await`). The single write port
> takes the `action` so the adapter re-asserts `assertMayPost` independently (defense-in-depth — the
> only engine→GitHub write call site stays gated even against a future engine bug). The live adapter
> `pipelineEngine.ts` (`buildEnginePorts`) binds those ports to the real runner/store/GitHub; its single
> write path is the pure `dispatchGithubWrite`, which re-asserts `assertMayPost` and routes commit→
> `createCommitComment` / pr→`createPrComment` / issue→`createIssue`. `loadEnabledPipelines` parses +
> validates each persisted config (skipping malformed/forged rows and, for now, tool-bearing pipelines).
> `poller.ts` is the single self-rescheduling timer that drives it: each tick it derives the watches
> for the enabled pipelines (commit-trigger → repo default branch), polls the due ones with
> `pollCommitHead`, and on a new head runs `processDelta` through the live ports — pacing each watch
> via `planNextPollAt` (rate backoff + jitter) under a global poll budget. It's started after the store
> is ready and stopped on `before-quit` (clears the timer + disposes the engine ports, never starting a
> run during shutdown), and idles cheaply with no enabled pipelines. This is a LOCAL poll loop, not a
> webhook (SPEC §10); auto-post stays a hard per-pipeline opt-in. The renderer manages pipeline CONFIG
> through an `isTrustedSender`-guarded IPC surface — `pipelines:list`/`save`/`delete`/`setEnabled`
> (`aerie.pipelines.*`); `save` re-validates the draft with `isPipelineDraft` and requires a known
> repo. These handlers persist config only and NEVER write to GitHub — a proposed `autoPost:true` just
> stores the flag; the engine's gate still decides whether anything is posted.

> **ETag-cached polling foundation (ROADMAP M8).** The automation engine needs to detect a
> new commit/PR head cheaply. `listCommits`/`listPullRequests` now mirror `listRepos`' ETag
> pattern: each list page is keyed in `http_cache` (`commits:`/`pulls:` namespace) with its
> ETag + JSON body, sent back as `if-none-match`; a **304** (which GitHub does NOT charge
> against the primary rate budget) replays the cached page (`Paginated.fromCache`). A new
> `watches` row tracks the **last-seen head SHA** per repo ref (`ref` = branch for `'commit'`,
> `pr:<n>` for `'pr'`). `pollCommitHead(account, repoId, repo, branch)` does a 1-item
> conditional commit probe and returns a `PollResult` (`headSha`, `changed`, `fromCache`,
> `rate`, `nextPollDelayMs`); `changed` is true only when the head differs from
> `last_seen_sha` (true on a fresh watch). A bare poll records `last_polled_at` only — the
> caller advances `last_seen_sha` via `markWatchSeen` **after** the delta is processed, so no
> commit is skipped. `rateLimit.ts` (pure) turns the `x-ratelimit-*` headers into a backoff:
> base cadence on a healthy budget, exponential as the budget shrinks, park-until-reset when
> exhausted. No write path and no renderer surface — this is main-only plumbing the M9a poller
> consumes. (The dedupe cache, triggers, and the auto-post actioner are M9a.)

> **Cross-agent consensus (ROADMAP M8/M9).** `aggregateFindings` (M6) gained a `groupBy:
> 'issue' | 'location'` option and a per-kept-finding `agreement` count. `'location'` groups by
> file+line ONLY — the robust cross-AGENT mode, since agents phrase the same issue differently and
> message-matching under-counts agreement. `runner:consensus({runIds, consensusMin, minSeverity,
> groupBy})` reads each run's persisted (already-redacted) findings, aggregates them, and returns
> `ConsensusFinding[]` (the kept findings + their agreement). A panel review of ≥2 agents shows a
> **Consensus** section keeping issues ≥`consensusMin` agents flagged at the same location. Pure
> aggregation over local data — no token/network/spawn.

> **Structured agent findings (ROADMAP M8/M9).** `buildPrompt` asks the LLM agent to append a
> fenced ```aerie-findings JSON array (`file/line/severity/ruleId/message`) after its prose.
> `parseAgentFindings(agentId, output)` (pure) extracts it best-effort — findings carry
> `tool = agentId` so cross-agent consensus counts distinct agents — and returns the prose with
> the block REMOVED. The runner writes that clean prose to `<id>.out` (and the posted comment),
> persists the findings (no diff-scoping — an agent's findings already pertain to the change),
> and runs the M-Q quality gate on the prose. Absent/malformed block → prose-only, run never
> fails. `runner:findings(runId)` returns a run's persisted findings (`RunFinding[]`) for display.
> The block is data, never executed; on-disk artifacts stay secret-scrubbed.

> **Multi-agent fan-out (ROADMAP M8/M9 — first slice).** `runner:startBatch` launches one
> review across several agents on a single ref: each eligible agent becomes its own
> correlated `runs` row (shared repo+sha+ref, differing agent, its own saved model), started
> via the same `startRun()` keystone, with concurrency bounded by the run semaphore. The
> shared validation + working-tree HEAD resolution is factored into one `resolveRunTarget`
> helper used by both `runner:start` and `runner:startBatch`. The pure `planBatch` decides which
> requested agents run (dedup + installed-only + cap 8) vs. are skipped. No new table — a "batch"
> is just the set of runs sharing a ref. Every per-run guarantee holds (no token in any agent
> env; GitHub writes still behind the explicit confirm). Cross-agent aggregation/consensus (reusing
> the M6 aggregator) and an actioner are later milestones; agents emit prose today, so structured
> cross-agent consensus needs structured agent output first.

> **Live model discovery (ROADMAP M2).** An agent template may carry an optional
> `modelDiscovery` descriptor (`{kind:'command', argv, format:'lines'}`) describing a
> non-interactive probe (e.g. `opencode models`) that lists the models the user can pick.
> The `runner:discoverAgents` IPC channel runs each installed, AUTHOR-SHIPPED probe with a
> token-stripped env + timeout/killTree, caches the result to `settings`, and returns the
> refreshed agent list; `listAgentInfos()` stays synchronous and overlays the cached list
> over the static seed (tagging `AgentInfo.modelsSource` `'static'|'discovered'`). A
> `modelDiscovery` on a USER-added agent is arbitrary local exec and is never run without
> exec-consent (M12); only shipped template/catalog ids are probed.

> **Agent-output reliability gate (ROADMAP M-Q).** Run status comes from the agent's exit
> code, but exit 0 ≠ a usable review. A pure, shared `assessReviewQuality(output)` classifies
> a spawned LLM run's captured output as `ok` or `low` (empty / truncated mid-stream / leaked
> reasoning-or-tool-call transcript / too short / a bare `[aerie]` error sentinel). `low` runs
> are surfaced as a caution in the run view and are **ineligible for auto-posting** once
> automation (M9) lands. Tool runs are not gated here — malformed tool JSON already degrades to
> "no findings" without failing the run; per-tool timeouts come from each agent's `timeoutSec`.

## 9. Staged build plan

Each stage: implement → meet acceptance criteria → commit (`stage-N: …`) → STOP.

### Stage 0 — Scaffold & guardrails
Build: electron-vite + React + TS, single window, `contextIsolation` on,
ESLint + Prettier, npm scripts (`dev`, `build`, `typecheck`, `lint`), minimal CI
(typecheck + lint + build).
**Accept:** `npm run dev` opens an empty window; `npm run build` produces a
runnable app; typecheck and lint pass clean.

### Stage 1 — Accounts & secure auth (multi-account)
Build: add account by PAT (classic or fine-grained), store token via
`safeStorage`, validate via Octokit (`users.getAuthenticated` + `rateLimit.get`),
list accounts, remove account.
**Accept:** add a PAT → see login + remaining rate limit; token survives restart;
token is not visible anywhere in the renderer / devtools; removing an account
wipes its token from the keychain.

### Stage 2 — Repo browser (cached, rate-limit-aware)
Build: list repos for the selected account (user + org), show default branch and
last push; client-side filter/search; cache rows in SQLite; use conditional
requests (ETag) so re-listing costs ~0 rate limit.
**Accept:** repos load; second load is served from cache and is visibly faster;
listing a large org does not exhaust the hourly rate limit; filter works.

### Stage 3 — Commit & PR drill-in (read-only)
Build: for a repo, list recent commits (with a branch selector) and open PRs;
click a commit → metadata + changed files + diff; click a PR → PR view + its
commits; "load more" pagination.
**Accept:** commits and PRs render; a commit diff displays correctly; pagination
loads older items without duplicating.

### Stage 4 — Repo mapping & git engine
Build: per-repo mapping UI (set/auto-detect `user_local_path`, store
`remote_url`); `gitEngine.ensureClone` (clone if missing, else fetch) into the
app clone cache; `checkoutSha` into an isolated worktree; generate a diff for a
given SHA. Implement the opt-in read-only worktree mode but default it OFF.
**Accept:** map a repo; trigger ensure-clone on a commit → repo present at the
target SHA in an app-owned worktree; the user's own dirty checkout is never
modified; diff file is produced.

### Stage 5 — Agent runner (THE WEDGE)
Build: load `agents.json`; "Review with agent" button on the commit and PR
views; runner = prepare context (checkout SHA + prompt file + diff file) →
spawn agent in `cwd` → stream stdout/stderr live to the UI → capture result →
persist a `runs` row. Ship the real agent config entries (`codex`, `claude-code`, …).
**Accept:** configure an installed agent and run it on a commit → live output
appears, run is recorded with exit code and output path; swapping to a second
agent is config-only with no code change; a hanging agent is killed at timeout.

### Stage 6 — Post results to GitHub
Build: from a finished run, post the agent output as a commit comment, or as a
PR comment when the commit belongs to a PR; optional "create issue from run".
Mandatory confirm dialog before any write. Store `posted_url` on the run.
**Accept:** run → confirm → post → the comment appears on GitHub with the correct
body and the URL is stored; cancelling the confirm posts nothing.

### Stage 7 — Hardening & packaging (personal prod)
Build: rate-limit backoff, token-expiry prompts, structured logs (no secrets),
run-history view, settings screen, SQLite migrations, `electron-builder`
packaging for macOS.
**Accept:** the packaged build runs; the full loop (browse → run → post) works
end to end; history persists across restarts; grep of the logs shows no tokens.

## 10. Non-goals for v1 (defer — do not build)

- Actions / workflow dashboard and history.
- User activity analytics or leaderboards.
- Org admin actions (members, settings, branch protection).
- Any GitHub write beyond commit/PR comments and the optional "create issue".
- Real-time webhooks. v1 is poll + cache only.

These are the commodity 80% GitHub already does. They come back only after the
loop in Stages 0–6 proves it saves real time.

## 11. How to proceed (instructions to the coding agent)

- Work one stage at a time, in order. Do not start stage N+1 until stage N's
  acceptance criteria pass.
- After each stage: run typecheck, lint, and the stage smoke test; commit;
  write a short note of what a human should manually verify; then STOP.
- Keep tokens out of logs and out of the renderer at all times.
- Prefer the smallest change that satisfies the stage. No speculative
  abstractions beyond the agent registry in §7.
- Target macOS first but keep the code cross-platform (no mac-only path
  assumptions); note any platform-specific handling you add.
- If a fixed stack choice in §3 blocks you, STOP and flag it — do not substitute.
