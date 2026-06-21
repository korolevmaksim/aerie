# CLAUDE.md — Aerie

Standing rules for any Claude Code session in this repo. They apply every session,
not just the first. For the one-time kickoff see `PROMPT.md`.

## What this repo is

Aerie — a personal GitHub mission-control **desktop app** (Electron + TypeScript)
whose core value is triggering **local AI coding agents** on a commit/PR against a
locally checked-out repo, then posting the review back to GitHub.

- `SPEC.md` — the full build specification. **Source of truth.** Read it before
  working. If anything here or in a request conflicts with `SPEC.md`, flag it.
- `PROMPT.md` — the staged kickoff prompt.

## Working agreement

- **Build stage by stage** (SPEC §9, Stage 0 → 7). One stage in flight at a time.
  Do not start the next stage until the current stage's `Accept:` block passes and
  the human has reviewed.
- **After each stage:** typecheck + lint + the stage smoke test green → commit
  `stage-N: <summary>` → STOP and report what to verify + decisions made.
- **Smallest change that satisfies the stage.** No speculative abstractions beyond
  the agent registry (SPEC §7).
- **Flag, don't substitute.** If a fixed stack choice (SPEC §3) fights the
  toolchain, stop and surface it — never swap a library/framework silently.

## Security model (non-negotiable — SPEC §4)

- `contextIsolation: true`, `nodeIntegration: false`, sandbox where possible.
- GitHub / git / agent / token operations run in the **main** process only. The
  renderer reaches them solely through the typed `contextBridge` API in preload.
- Tokens: encrypted at rest via `safeStorage`; never sent to the renderer; never
  written to a log.
- **Every GitHub write** (comment, issue) sits behind an explicit in-app confirm.
- Agent runs use **app-owned clones**, never the user's working copies, unless the
  user opts a repo into read-only worktree mode (default OFF).

## Architecture boundaries

- `main/` does the privileged work; `renderer/` is UI only and never imports Node,
  touches tokens, or shells out to git/agents directly.
- All renderer → main calls go through the typed IPC surface. Keep that surface
  small and explicit.

## Scope (v1 non-goals — do not build — SPEC §10)

Actions/workflow dashboard, activity analytics, org admin actions, any GitHub
write beyond commit/PR comments + optional issue creation, real-time webhooks.
These are commodity features GitHub already provides; they return only after the
Stage 0–6 loop proves it saves real time.

## Conventions

- TypeScript strict mode on. All code, comments, and commit messages in English.
- Each stage ships a smoke test proving its `Accept:` criteria. Use the `dummy`
  agent (SPEC §7) to test the runner with zero real agents installed.
- Target macOS first; keep code cross-platform (no mac-only path assumptions).
- Verify current tool/lib versions before pinning; if the spec's pin is stale,
  propose the current equivalent and wait for confirmation.

## Definition of done (per stage)

The stage's `Accept:` block passes, typecheck and lint are green, and the repo is
in a committed, runnable state.
