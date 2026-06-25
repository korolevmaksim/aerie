# Aerie Design System

> Inspiration: the OpenAI / ChatGPT desktop product UI (chat, Automations, Settings,
> "Welcome back"). The brief was to adopt that language: a near-black, almost-monochrome,
> calm surface where **color is the exception, not the rule** — hierarchy comes from spacing,
> type weight, subtle surface steps, and hairline borders, never from decoration.

Aerie's visual layer is **token-driven**: every color, type, spacing, radius, motion, and
elevation value is a CSS custom property defined once in `src/renderer/src/assets/main.css`
(shell composition in `shell.css`). Components reference only tokens and semantic class names —
there are **no inline styles** in the renderer — so the whole UI can be re-skinned by editing
the token blocks.

## 1. Atmosphere & principles

1. **Near-monochrome.** The chrome is grayscale on a near-black canvas (white canvas in light
   mode). One restrained **warm accent** is reserved for a few interactive moments; functional
   green/amber/red appear only for status and diffs, muted.
2. **Calm and roomy.** Generous whitespace, comfortable line lengths, hairline dividers between
   rows. Prefer air over density.
3. **Flat.** Elevation is carried by surface steps + hairline borders, not shadows. Shadows are
   reserved for true overlays (modals, popovers, command palette).
4. **Soft geometry.** Medium-to-large radii; pills for tags and toggles.
5. **Quiet motion.** Short, eased transitions on hover/active/focus. Respect
   `prefers-reduced-motion`.
6. **Contrast where it counts.** The single most important action on a surface is a
   high-contrast **neutral** button (near-white on dark, near-black on light) — not a colored
   fill. Everything else is bordered/ghost.

## 2. Color tokens

Dark is the default (`:root`); light overrides the same tokens in
`@media (prefers-color-scheme: light)`, so Aerie follows the OS appearance.

### Surfaces

| Token | Dark | Light | Role |
|---|---|---|---|
| `--bg` | `#0d0d0d` | `#ffffff` | App canvas |
| `--panel` | `#171717` | `#ffffff` | Cards / panels |
| `--bg-surface` | `#1f1f1f` | `#f7f7f8` | Inputs, inset rows, tracks |
| `--bg-raised` | `#262626` | `#ffffff` | Modals, popovers, palette |
| `--bg-hover` | `rgba(255,255,255,.055)` | `rgba(0,0,0,.045)` | Hover overlay (composites over any surface) |
| `--bg-active` | `rgba(255,255,255,.09)` | `rgba(0,0,0,.075)` | Pressed / selected overlay |
| `--bg-sidebar` | `#0a0a0a` | `#f9f9f9` | Sidebar / window drag band |
| `--bg-code` | `#0a0a0a` | `#0a0a0a` | Console / diff (dark in both themes) |
| `--fg-code` | `#e6e6e6` | `#e6e6e6` | Console / diff text |

Hover/active are **translucent overlays** so they read correctly on canvas, panels, and cards
alike — never hard-code a solid hover fill.

### Hairlines

| Token | Dark | Light | Role |
|---|---|---|---|
| `--border` | `rgba(255,255,255,.10)` | `rgba(0,0,0,.10)` | Default hairline (cards, dividers, inputs) |
| `--border-hover` | `rgba(255,255,255,.20)` | `rgba(0,0,0,.20)` | Hover hairline |
| `--border-default` | `rgba(255,255,255,.10)` | `rgba(0,0,0,.10)` | Alias used by the shell |
| `--border-focus` | `var(--accent)` | `var(--accent)` | Field focus border |

### Text

| Token | Dark | Light | Role |
|---|---|---|---|
| `--fg` | `#ededed` | `#0d0d0d` | Primary text |
| `--fg-muted` | `#cdcdcd` | `#3a3a3a` | Secondary text (inactive nav, labels) |
| `--muted` | `#9b9b9b` | `#6e6e6e` | Meta, captions, descriptions |
| `--fg-subtle` | `#707070` | `#9b9b9b` | Placeholder, disabled, tertiary |

### Accent (warm — used sparingly)

| Token | Dark | Light | Role |
|---|---|---|---|
| `--accent` | `#f0865a` | `#d96b3a` | Focus ring, caret, links, finding locations, brand mark, running state |
| `--accent-hover` | `#ff9d73` | `#c25a2c` | Accent hover |
| `--accent-muted` | `rgba(240,134,90,.16)` | `rgba(217,107,58,.12)` | Accent tint |
| `--accent-border` | `rgba(240,134,90,.45)` | `rgba(217,107,58,.45)` | Accent hairline |
| `--on-accent` | `#1a1207` | `#ffffff` | Text on an accent fill (rare) |

### Primary (neutral high-contrast) button

| Token | Dark | Light |
|---|---|---|
| `--btn-primary-bg` | `#f2f2f2` | `#0d0d0d` |
| `--btn-primary-bg-hover` | `#ffffff` | `#2b2b2b` |
| `--btn-primary-fg` | `#0d0d0d` | `#ffffff` |

### Semantic (muted)

| Token | Dark | Light | Role |
|---|---|---|---|
| `--ok` | `#4eb87a` | `#1f9d4d` | success (+ `--ok-bg` / `--ok-border`) |
| `--mid` | `#d9a441` | `#b07d12` | warning / at-risk (+ bg/border) |
| `--low` / `--danger` | `#e96a62` | `#cf4b44` | danger / destructive (+ bg/border) |

**Accent discipline:** chrome stays grayscale. The warm accent is for the caret, focus,
links/finding locations, the brand mark, and the active "running" state — nothing else. Status
uses the semantic trio. Never introduce a second chromatic hue, gradients on text, or glows.

## 3. Typography

- `--font-sans`: `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, …` —
  native-grade on macOS, no network/CSP dependency (the app is offline). A clean humanist
  grotesque, matching the reference's OpenAI Sans feel.
- `--font-mono`: `'SF Mono', ui-monospace, 'JetBrains Mono', …` for code, diffs, SHAs, kbd, ids.
- Weights: `--weight-regular 420`, `--weight-medium 530`, `--weight-semibold 620`,
  `--weight-bold 700`.
- Body: `0.9375rem` / line-height `1.55`, letter-spacing `-0.006em`, ligatures on.
- Headings (`h1–h3`): letter-spacing `-0.021em`, semibold/bold. Large page titles (e.g. the
  cockpit / "Welcome") read big and confident.
- Numbers in metrics/rates/reports use `font-variant-numeric: tabular-nums`.

## 4. Spacing

A 4px base scale, exposed as tokens and used for new/changed rules:

`--space-1 4px` · `--space-2 8px` · `--space-3 12px` · `--space-4 16px` · `--space-5 20px` ·
`--space-6 24px` · `--space-8 32px` · `--space-10 40px` · `--space-12 48px`.

Density guidance: card padding ≈ `--space-4`/`--space-5`; settings & list rows ≈ `--space-3`
vertical with a hairline divider; section gaps ≈ `--space-4`/`--space-6`; nav items ≈
`--space-2`/`--space-3`. Lean roomy.

## 5. Radii

`--radius-sm 6px` · `--radius-md 8px` · `--radius-lg 12px` · `--radius-xl 16px` ·
`--radius-full`. Cards/modals use `lg`/`xl`; inputs/buttons `md`; tags, toggles, and selectable
chips use `full`.

## 6. Elevation & shadows

Flat by default — hierarchy is surface + hairline. Tokens stay subtle:

- `--shadow-sm: 0 1px 2px rgba(0,0,0,.18)` — buttons/fields only.
- `--shadow-md: 0 4px 16px rgba(0,0,0,.3)` — raised controls.
- `--shadow-lg: 0 16px 48px rgba(0,0,0,.5)` — overlays (modal, palette) + backdrop blur.

Cards rely on `--border`, **not** shadow. There are no accent glows.

## 7. Component conventions

- **Buttons** — `.btn` is a bordered neutral control on `--bg-surface`; `.btn--primary` is the
  high-contrast neutral button (`--btn-primary-*`), one per surface; `.btn--ghost` is
  transparent until a `--bg-hover` overlay; `.btn--danger` is red text with a red tint on hover.
- **Fields** — inset `--bg-surface`, hairline border, focus = `--border-focus` + a soft
  `--accent-muted` ring; `caret-color: var(--accent)` (the warm caret detail); placeholders use
  `--fg-subtle`.
- **Tabs / segmented controls** (`.tabs`, `.review-launcher__mode`) — a bordered `--bg-surface`
  track; the active segment is a raised `--panel` fill; inactive segments are muted and lift to a
  `--bg-hover` overlay. Never plain text links.
- **Sidebar nav** — items are muted; hover/active use neutral overlays (`--bg-hover` /
  `--bg-active`) with no colored bar, matching the reference's neutral active state.
- **Rows & settings** — list/settings rows are separated by hairline dividers (`--border`),
  label + control on a line with a muted description below; roomy vertical padding.
- **Cards / stat tiles** — `--panel` fill, `--border` hairline, `--radius-lg`, no shadow; metric
  value large + tabular over a muted micro-caps label.
- **Badges / chips / status pills** — pill radius, uppercase micro-caps; informational metadata
  is a neutral `--muted` chip (accent reserved for state/counts).
- **Selectable chips** (`.run__agent-pick`) — pills; `:has(input:checked)` gets `--accent-muted`
  + `--accent-border`. Native checkboxes/radios use `accent-color: var(--accent)`.
- **Code** — inline code and SHAs use `--font-mono` in neutral `--fg-muted` (no accent);
  consoles/diffs sit on `--bg-code` (dark in both themes); diff hunks are muted, add/del use
  faint green/red tints.

## 8. Guardrails (do / don't)

- **Do** build new surfaces from the ladder and new states from the existing tokens/overlays.
- **Do** keep every interactive element's `:focus-visible` ring (accent) — accessibility.
- **Do** keep the app calm: when in doubt, use a hairline and more space, not a color.
- **Don't** hard-code hex colors in component rules — reference a token.
- **Don't** add a second chromatic accent, gradients on text, or glow shadows.
- **Don't** use opaque `rgba(255,255,255,…)`/`rgba(0,0,0,…)` as a *surface* fill (only as the
  hover/active overlay tokens); for real surfaces use `--panel` / `--bg-surface` / `--bg-raised`.
- **Don't** color the primary button — contrast (neutral) is the affordance.
