# Security Policy

Aerie stores GitHub Personal Access Tokens, spawns local AI-agent CLIs against
checked-out code, and posts to GitHub. Security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report privately via GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Report a vulnerability" under the repository's **Security** tab). Include a
description, affected version/commit, reproduction steps, and impact. Expect an
initial response within a reasonable time; please allow a fix to ship before public
disclosure.

## Supported versions

This project is pre-1.0; only the latest release / `main` is supported with security
fixes.

## Threat model & guarantees

Aerie is designed around these boundaries (see the README's _Security model_):

- The renderer runs with `contextIsolation: true`, `nodeIntegration: false`, and
  `sandbox: true`. It has no Node access and never receives a token.
- All GitHub/git/token/agent operations run in the **main process**, reached only
  through a small typed `contextBridge` IPC surface that validates every call.
- Tokens are encrypted at rest via Electron `safeStorage`, are never written to logs,
  and are **never** placed in an agent's environment.
- Agents run on **app-owned clones** (read-only worktree mode is opt-in, default off).
- **Every** GitHub write requires explicit in-app confirmation.

### Out of scope / known constraints

- **Local agent CLIs are third-party software.** Aerie runs the agents you have
  installed, with the arguments in your `agents.json`. A malicious or compromised agent
  binary, or an `agents.json` you did not vet, runs with your user privileges. Only
  install and configure agents you trust.
- Distributed builds are currently **unsigned/un-notarized**; verify your download
  source.
- Issues in upstream dependencies should be reported to those projects (we track them
  via Dependabot and will update promptly).
