# Aerie UI/UX Research Notes

Date: 2026-06-23

## Product Question

Aerie had grown into a set of capable tabs: Repos, History, Tools, Automate, Accounts,
and Settings. The core product promise is narrower and sharper: run local AI coding
agents against a commit, PR, or working tree, inspect the result, then post or reuse it
under explicit control. The UI should therefore organize around the review loop and the
operator's attention, not around implementation modules.

## External Patterns Reviewed

- [GitHub pull requests dashboard public preview](https://github.blog/changelog/2026-03-26-new-pull-requests-dashboard-is-in-public-preview/)
  moved toward an inbox, saved views, and stronger filtering. Takeaway: the default
  review surface should answer "what needs my attention?" before exposing full browsing.
- [GitKraken Launchpad](https://help.gitkraken.com/gitkraken-desktop/gitkraken-launchpad/)
  centralizes pull requests, issues, and works in progress across a workspace. Takeaway:
  a Git desktop app needs an at-a-glance launch surface, not only repo-by-repo drilldown.
- [VS Code multi-agent development](https://code.visualstudio.com/blogs/2026/02/05/multi-agent-development)
  frames local, background, and cloud agents as sessions to track in one place. Takeaway:
  agent work needs a persistent session list that survives navigation.
- [GitHub Agent HQ](https://github.blog/news-insights/company-news/welcome-home-agents/)
  explicitly uses a unified workflow for orchestrating multiple agents. Takeaway:
  multi-agent orchestration is becoming a control-plane problem, not a chat-tab problem.
- [CodeRabbit Review](https://coderabbit.ai/blog/introducing-atlas-the-first-ai-native-code-review-interface)
  turns a flat PR file list into guided logical cohorts and ordered layers. Takeaway:
  AI review UX wins when it restructures raw developer data into a better reading order.
- [Sentry Issues](https://docs.sentry.io/product/issues/)
  separates unresolved, for-review, regressed, archived, and escalating issue streams.
  Takeaway: attention states should be first-class filters, not buried in a generic log.
- [Raycast](https://www.raycast.com/) and its extension model reinforce command-first,
  keyboard-friendly workflows. Takeaway: the command palette is an accelerator over a
  clear primary UI, not a replacement for one.
- [Nielsen Norman Group: dashboards](https://www.nngroup.com/articles/dashboards-preattentive/)
  defines dashboards as at-a-glance views for frequently monitored information and fast
  action. Takeaway: the cockpit must prioritize few, actionable signals over broad data.
- [Nielsen Norman Group: accelerators](https://www.nngroup.com/articles/ui-accelerators/)
  recommends shortcuts as alternate paths for expert users. Takeaway: keep Cmd/Ctrl-K,
  but make the visible workflow good enough without it.
- [Nielsen Norman Group: tabs](https://www.nngroup.com/articles/tabs-used-right/)
  stresses consistent tab behavior and suitable content scope. Takeaway: top-level tabs
  should not become the whole app information architecture when the product has a clear
  workflow spine.
- [Atlassian navigation redesign](https://www.atlassian.com/blog/design/designing-atlassians-new-navigation)
  emphasizes predictability, user control, and progressive disclosure. Takeaway: use a
  durable side navigation for repeated work, then disclose advanced areas as needed.

## Current Aerie Issues

- The first screen was a repository list, so the product opened as a browser rather than
  a review cockpit.
- The main navigation was a flat tab set of features. That made History, Tools, and
  Automate feel unrelated even though they are all parts of one agent-review loop.
- Active and attention-worthy runs were visible only after opening History or returning
  to a specific commit/PR context. This made agent work feel easier to lose than to track.
- Agent readiness and automation liveness were hidden in separate surfaces. A failed run
  could be caused by tool availability or approval state, but the run surface did not make
  that readiness visible up front.
- The UI optimized for feature discovery, not repeated operation. Repeated use should
  start from "what needs attention now?" and "where do I launch the next review?"

## Redesign Principles

1. **Cockpit first.** Default authenticated users to an account-scoped review cockpit with
   active runs, attention queue, review targets, agent readiness, automation health, and
   trust boundaries.
2. **Task-based navigation.** Replace the top feature tabs with a left navigation organized
   by the working loop: Cockpit, Repositories, Run history, Automate, Agents & tools,
   Accounts, Settings.
3. **Attention states over raw logs.** Promote active, failed, stopped, ready-to-post, and
   posted states into compact metrics and queues.
4. **Readiness beside work.** Show installed agent count, approval state, enabled pipeline
   count, and poller liveness without forcing a context switch.
5. **Command palette as accelerator.** Preserve Cmd/Ctrl-K for speed, but keep the visible
   shell predictable and complete.
6. **No new privilege.** The redesign remains renderer-only and does not add IPC, GitHub
   write paths, token exposure, or agent execution paths.

## Implemented Slice

- Added a default `Review cockpit` view for authenticated sessions.
- Replaced top feature tabs with a workflow sidebar and explicit account scoping.
- Added cockpit metrics for active, attention, ready-to-post, completed, and posted runs.
- Added an attention queue and live in-progress queue that deep-link into History run logs.
- Added review target shortcuts for favorite/recent repositories.
- Added right-rail readiness cards for agents, automation, and trust boundaries.
- Kept all data access on existing renderer-safe IPC calls.

---

Date: 2026-06-24

## Product Question: Panel Review Consolidation

The next failure was not visual polish: three simultaneous agents produced three separate
History rows and no durable combined report. The operator had to copy each agent result into
another tool manually. For a local agent mission-control app, that breaks the core promise.

## External Patterns Reviewed

- [GitHub Copilot code review](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review)
  behaves like a reviewer inside the pull request: comments are readable, resolvable, and
  can include suggested fixes. Takeaway: the user should receive review objects, not raw
  model transcripts.
- [GitHub Copilot PR summary](https://docs.github.com/en/copilot/how-tos/copilot-on-github/copilot-for-github-tasks/create-a-pr-summary)
  generates a summary in a PR description/comment, but asks the user to review it before
  publishing. Takeaway: consolidated output should be copy/post-ready but still editable and
  confirm-gated.
- [CodeRabbit review overview](https://docs.coderabbit.ai/guides/code-review-overview)
  combines multiple AI models and static analysis, then publishes summaries, security
  findings, improvement suggestions, and continuous incremental updates. Takeaway: aggregate
  findings by priority and keep the evidence trail.
- [CodeRabbit command controls](https://docs.coderabbit.ai/guides/commands) distinguish full
  review, incremental review, summary updates, and resolve/approval actions. Takeaway:
  review history needs durable state and explicit controls, not session-only buttons.
- [Qodo code review](https://docs.qodo.ai/code-review) describes specialized review agents,
  shared context, rule enforcement, and low-noise prioritization. Takeaway: panel review
  should surface consensus/noise information before raw per-agent logs.
- [Cursor Bugbot](https://cursor.com/bugbot) emphasizes real bugs directly in GitHub, custom
  rules, and fixes from the review surface. Takeaway: the useful unit is an actionable
  finding tied to code, with child evidence available when needed.

## Aerie Decision

Panel review is now a persisted group over normal child runs:

- History and Cockpit show one **panel** row for the target, not one row per agent.
- The panel report survives navigation and app restarts because `run_groups` /
  `run_group_items` persist the grouping.
- The default reading order is consolidated: status/progress, consensus findings,
  single-source findings to triage, then child agent reports as expandable evidence.
- Copy and GitHub posting use one consolidated Markdown report. Posting is still
  confirm-gated, and main derives the commit/PR/issue target from the stored group target.
- Child runs remain visible inside the panel for logs, kill/status handling, and debugging,
  but they are no longer the top-level UX artifact.

---

Date: 2026-06-24

## Product Question: Visual Maturity

The cockpit information architecture was sound, but the *visual* layer still read as a
prototype rather than a product: a three-stop rainbow gradient wordmark, an indigo accent
fighting hard-coded blues in several places, harsh near-black backgrounds with cheap accent
glows, untreated system typography, and — most damaging — **four design tokens that were
referenced but never defined** (`--bg-hover`, `--bg-active`, `--fg-muted`, `--border-default`),
so hover and active states silently did nothing. This pass is appearance-only: no component
logic, IPC, or behavior changed.

## External Patterns Reviewed

- [Linear design system](https://linear.app) — the benchmark for serious dark-first desktop
  tooling. Near-black canvas (`#08090a`) with a layered surface ladder, a tiered grayscale
  text hierarchy (`#f7f8f8` / `#d0d6e0` / `#8a8f98` / `#62666d`), **one** restrained
  lavender-indigo accent (`#5e6ad2`), Inter at custom weights with negative tracking, and
  flat elevation carried by hairline borders rather than shadows. Takeaway: discipline scales
  — one accent, a surface ladder, hairlines, and tracking do almost all the work.
- [Anthropic / Claude](https://claude.ai) — warm ivory canvas (`#faf9f5`), warm-black ink
  (never cool gray on a warm field), a single clay accent (`#cc785c`), serif display + sans
  body, flat surface bands, no gradients. Takeaway: a single accent held in reserve plus a
  thermally-consistent neutral ramp reads as "made by people with a point of view".
- [GitHub Primer / Copilot](https://primer.style) — functional semantic tokens shared across
  modes (`canvas.default #0d1117`, `fg.default #e6edf3`, `fg.muted #8b949e`, `border #30363d`,
  `accent #2f81f7`). Takeaway: model color as semantic roles so light/dark stay in lockstep,
  and keep code/console surfaces deliberately inset.
- 2026 developer-tool convention (Zed, Cursor, Warp, Raycast, Geist) — cool-neutral or
  warm-tinted surfaces over true black, comfortable density (≈4px base, ≈13–15px body),
  tabular numerals for metrics, and avoidance of generic "shadcn-default" gradients/glows.

## Aerie Decision

A single, disciplined, token-driven design language (dark-first, light theme in lockstep):

1. **One accent.** A refined indigo-violet (`#6970e6` dark / `#5a61d6` light), used scarcely
   for primary actions, focus, links, and active nav. Every previously hard-coded blue/amber
   (palette, mode toggles, findings, hunk headers, warnings) now routes through accent or the
   semantic tokens, so there is no second chromatic color.
2. **Surface ladder, not glows.** `canvas → panel → surface → raised` (`#0b0d10 → #111418 →
   #171b21 → #1c212a`) with hairline borders and soft, flat shadows; the accent glow on the
   primary button and the `--shadow-glow` were removed.
3. **Tiered text + intentional type.** Four text tiers (`--fg / --fg-muted / --muted /
   --fg-subtle`), a native-grade system stack (SF Pro on macOS) with negative tracking on
   headings, tabular numerals on metrics, and unified `--font-mono` everywhere.
4. **Solid wordmark.** The rainbow-gradient text wordmark became a solid wordmark with one
   small accent mark — the single decorative device.
5. **Defined interaction states.** The four undefined tokens are now real, so hover/active
   states work across buttons, rows, nav, and cards.
6. **Theme-aware everywhere.** Surfaces that hard-coded `rgba(255,255,255,0.02)` (panel-report
   tiles, agent cards) now use tokens, so light theme no longer renders invisible fills;
   consoles/diffs stay intentionally dark in both themes (terminal convention).
7. **No new privilege.** Purely a renderer styling change in `main.css` / `shell.css` and
   `index.html`; no IPC, GitHub write, token, git, or agent surface was touched.

The full token reference and component rules live in `docs/design-system.md`.

---

Date: 2026-06-25

## Product Question: Adopt the OpenAI / ChatGPT visual language

The disciplined indigo system was a real step up, but the owner identified a specific design
language he wants Aerie to match: the **OpenAI / ChatGPT desktop product UI** (chat view,
Automations, Settings, the "Welcome back" home). The reference was supplied directly as
screenshots.

## Pattern Reviewed (the reference itself)

- **Near-monochrome, near-black canvas.** The entire chrome is grayscale on `~#0d0d0d` (white in
  light mode). Color is the exception — a tiny warm-orange caret, muted green/red for diffs,
  otherwise none. Takeaway: hierarchy must come from spacing, weight, surface steps, and
  hairlines, not color.
- **Hairlines over shadows.** Cards and settings rows are separated by ~1px translucent borders;
  there is essentially no shadow except on true overlays. Takeaway: go flat; reserve shadow for
  modals/popovers.
- **Neutral high-contrast primary button.** The single prominent action (e.g. send) is a
  near-white button on dark, dark text — not a colored fill. Takeaway: contrast, not hue, is the
  primary affordance; everything else is bordered/ghost.
- **Roomy, calm layout.** Generous padding, hairline-divided settings rows (label + control +
  muted description), large confident page titles. Takeaway: lean roomy.
- **Soft geometry + pills.** Medium-large radii on cards/inputs; fully-rounded tabs, toggles,
  and chips with neutral (not colored) active fills.

## Aerie Decision

Re-theme the whole token layer from "single indigo accent" to the OpenAI-style language:
near-monochrome grayscale chrome, one reserved **warm accent** (`#f0865a` dark / `#d96b3a`
light) for the caret/focus/links/finding-locations/brand mark/running state only, muted
semantic green/amber/red, translucent hover/active overlays, hairline borders, flat elevation,
a 4px spacing scale, larger radii, and a **neutral high-contrast primary button**
(`--btn-primary-*`). Codified in `docs/design-system.md`; applied app-wide via tokens plus
targeted component rules (primary button, neutral nav active state, neutralized code/SHA/hunk,
the warm caret, airier spacing). Appearance-only — no component logic, IPC, GitHub write, token,
git, or agent surface changed.
