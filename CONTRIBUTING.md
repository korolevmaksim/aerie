# Contributing to Aerie

Thanks for your interest! Aerie is a focused project — please read this before opening a
PR.

## Development setup

```bash
npm install      # postinstall rebuilds better-sqlite3 (needs a C/C++ toolchain — see README)
npm run dev      # run the app
```

## Before you open a PR

All of these must pass — CI runs them too:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

- TypeScript runs in **strict** mode. No `any` escapes, no type errors.
- Keep code, comments, and commit messages in **English**.
- Match the existing style and conventions; Prettier is the formatter (`npm run format`).
- Make the **smallest change** that solves the problem — no speculative abstractions.

## Non-negotiable boundaries

These are the core of the app; a PR that breaks them won't be merged (see the README's
_Security model_ and `SPEC.md`):

- The **renderer is UI only**. It must not import Node, touch tokens, or shell out to
  git/agents. All renderer → main communication goes through the typed preload IPC
  surface — keep that surface small and explicit.
- **GitHub / git / token / agent work stays in the main process.** Tokens are encrypted
  via `safeStorage`, never sent to the renderer, never logged, never put in an agent's
  environment.
- **Every GitHub write stays behind an explicit in-app confirmation.**

## How this repo is built

`SPEC.md` is the source of truth and the work is staged (see `PROMPT.md`). New work should
fit that structure: a focused change, with a test where there's non-trivial logic, left in
a committed, runnable, green state.

## Reporting bugs and security issues

- Bugs / features: open a GitHub issue with steps to reproduce.
- Security vulnerabilities: **do not** open a public issue — see
  [SECURITY.md](.github/SECURITY.md).

## License

By contributing, you agree your contributions are licensed under the project's
[MIT License](LICENSE).
