# Aerie — Implementation Prompt for Claude Code

You are implementing **Aerie**, a personal GitHub mission-control desktop app.
The full build specification is in `SPEC.md` at the repo root. Read it first and
treat it as the single source of truth. This file tells you HOW to execute it.

## Prime directives

1. **Read `SPEC.md` in full before writing any code.** If anything here conflicts
   with `SPEC.md`, `SPEC.md` wins — flag the conflict instead of guessing.
2. **Build strictly stage by stage** (Stage 0 → Stage 7). Do NOT start stage N+1
   until stage N's `Accept:` criteria pass and I have reviewed.
3. **After each stage:** run typecheck + lint + the stage smoke test, commit as
   `stage-N: <summary>`, then STOP and report: (a) what you built, (b) exactly
   what I should manually verify, (c) every non-trivial decision you made. Wait
   for my go before continuing.
4. **Smallest change that satisfies the stage.** No speculative abstractions
   beyond the agent registry (SPEC §7). No drift into the §10 non-goals.
5. **Security model (SPEC §4) is non-negotiable:** tokens live only in the main
   process, encrypted via `safeStorage`, never exposed to the renderer or written
   to logs; every GitHub write sits behind an explicit confirm step.
6. **If a fixed stack choice (SPEC §3) fights the toolchain, STOP and flag it.**
   Do not silently substitute a different library or framework.

## Environment

- Repo: this directory. Target macOS first; keep the code cross-platform (no
  mac-only path assumptions).
- **Verify current tooling before scaffolding:** check the current state of
  `electron-vite`, Electron, and `better-sqlite3` + `electron-rebuild`
  compatibility. If the spec's pinned approach is stale, propose the current
  equivalent and wait for my confirmation before changing the stack.
- Node + npm assumed available. Use npm unless I say otherwise.

## How to use planning and subagents (agentic mode)

- **Plan before each stage:** restate the stage's deliverable and `Accept:`
  criteria, list the files you will touch, and name the risks. Show me the plan
  for Stage 0; for later stages a short plan in your stage report is enough.
- **Parallelize only independent, read-only work** — e.g. researching the current
  electron-vite setup, checking Octokit method shapes, drafting a test. Converge
  all file writes into one coherent change set. Never let two subagents edit the
  same files.
- **Never parallelize across stages.** Exactly one stage in flight at a time.

## Definition of done (per stage)

The stage's `Accept:` block in `SPEC.md` passes, typecheck and lint are green,
and the repo is in a committed, runnable state.

## Testing

- Each stage ships a smoke test (a script or a minimal automated check) that
  proves its acceptance criteria.
- For the agent runner (Stage 5), use the `dummy` agent from SPEC §7 so the full
  pipeline is testable with zero real agents installed.
- Prefer a thin real integration path over heavy mocking. I will provide a test
  GitHub account/token and a throwaway repo when a stage needs one — ask.

## Start now — Stage 0 only

1. Confirm you have read `SPEC.md` and give me a 5-line restatement of the
   architecture in your own words, so I know you parsed it.
2. Give me the Stage 0 plan: files, npm scripts, and the exact tool/lib versions
   you intend to pin — plus the results of your tooling-version check.
3. Implement Stage 0: scaffold electron-vite + React + TypeScript, single window,
   `contextIsolation` on, ESLint + Prettier, npm scripts (`dev`, `build`,
   `typecheck`, `lint`), and a minimal CI workflow (typecheck + lint + build).
4. Verify acceptance: `npm run dev` opens an empty window; `npm run build`
   produces a runnable app; typecheck and lint pass clean.
5. Commit `stage-0: scaffold & guardrails`, report per the rules above, and STOP.
   Do not proceed to Stage 1.
