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
