# Design — Aerie

A locked design system for this app. Every page redesign reads this file before
emitting code. Do not regenerate per page — extend or amend this file when the
system needs to grow.

## Genre
modern-minimal

## Macrostructure family
- App pages: Workbench (sidebar + workspace grid, single-page-app with tabbed views)

## Theme
Warm-accent near-monochrome. Dark is default; light adapts via `prefers-color-scheme`.

### Dark mode
- `--bg`              oklch(15.91% 0 0)
- `--panel`           oklch(20.46% 0 0)
- `--bg-surface`      oklch(23.93% 0 0)
- `--bg-raised`       oklch(26.86% 0 0)
- `--bg-hover`        oklch(25.62% 0 0)
- `--bg-active`       oklch(29.31% 0 0)
- `--bg-sidebar`      oklch(14.48% 0 0)
- `--fg`              oklch(94.61% 0 0)
- `--fg-muted`        oklch(84.83% 0 0)
- `--muted`           oklch(68.95% 0 0)
- `--fg-subtle`       oklch(54.52% 0 0)
- `--accent`          oklch(72.72% 0.1426 42.7)
- `--accent-hover`    oklch(78.75% 0.1303 43.7)

### Light mode
Surfaces are warm-tinted toward the accent hue (~55° amber), not flat white.
- `--bg`              oklch(99.2% 0.004 55)
- `--panel`           oklch(99.8% 0.002 55)
- `--bg-surface`      oklch(97.5% 0.003 55)
- `--bg-raised`       oklch(99.5% 0.002 55)
- `--bg-hover`        oklch(95.5% 0.003 55)
- `--bg-active`       oklch(93% 0.004 55)
- `--bg-sidebar`      oklch(98% 0.003 55)
- `--accent`          oklch(64.97% 0.1518 43.1)
- `--accent-hover`    oklch(58.91% 0.1460 42.6)

### Semantic
- `--ok`   dark oklch(70.43% 0.1344 155)   · light oklch(61.24% 0.1578 150)
- `--mid`  dark oklch(75.07% 0.1295 79.8)  · light oklch(62.51% 0.1254 78.8)
- `--low`  dark oklch(67.68% 0.1593 25.8)  · light oklch(59.19% 0.1685 26.6)

### Borders
Translucent hairlines — `rgba(255, 255, 255, 0.1)` dark / `rgba(0, 0, 0, 0.1)` light.
Focus ring: `var(--accent)` at 2 px offset.

## Typography
- Display + body: system stack (`-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`)
- Mono: `'SF Mono', ui-monospace, 'JetBrains Mono', 'Cascadia Code', SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace`
- Weight stops: regular 420 · medium 530 · semibold 620 · bold 700
- Display tracking: -0.021 em
- Body: 0.9375 rem / 1.55 line-height / -0.006 em tracking

## Spacing
4-point named scale. Pages MUST use named tokens, never raw values.

| Token          | Value    |
|----------------|----------|
| `--space-1`    | 4 px     |
| `--space-2`    | 8 px     |
| `--space-3`    | 12 px    |
| `--space-4`    | 16 px    |
| `--space-5`    | 20 px    |
| `--space-6`    | 24 px    |
| `--space-8`    | 32 px    |
| `--space-10`   | 40 px    |
| `--space-12`   | 48 px    |

## Border radii
| Token            | Value    |
|------------------|----------|
| `--radius-sm`    | 6 px     |
| `--radius-md`    | 8 px     |
| `--radius-card`  | 10 px    |
| `--radius-lg`    | 12 px    |
| `--radius-xl`    | 16 px    |
| `--radius-full`  | 9999 px  |

## Motion
- `--transition-fast`: 110 ms cubic-bezier(0.4, 0, 0.2, 1)
- `--transition-normal`: 200 ms cubic-bezier(0.4, 0, 0.2, 1)
- **Never** use `transition: all`. Always specify explicit properties.
- Animate `transform` and `opacity` only — never layout properties.
- Support `prefers-reduced-motion: reduce` (blanket rule suppresses all transitions and animations).

## Microinteractions stance
- Silent success. Toasts only for failures, async results, or explicit confirmations.
- Optimistic update + Undo over confirmation dialogs.
- Hover delay 800 ms · focus delay 0 ms for tooltips.
- Focus rings: instant, never animated. `:focus-visible` only (mouse focus suppressed).

## CTA voice
- Primary: high-contrast neutral fill (near-white on dark, near-black on light). Contrast is the affordance.
- Secondary: bordered surface button. Ghost variant for tertiary.
- Danger: transparent bg, red text, red-tinted hover.
- All buttons: `var(--radius-md)` corners, `0.45rem 0.85rem` padding.

## Elevation
Flat. Cards rely on hairline borders. Shadow is for overlays only (`--shadow-sm`, `--shadow-md`, `--shadow-lg`).

## Per-page allowances
- All pages are app pages. No marketing pages exist.
- No enrichment (typography and structural hierarchy carry the design).
- Consoles/diffs stay dark in light mode — terminal convention reads as deliberate.

## What pages MUST share
- The wordmark ("Aerie") + small accent-gradient square.
- The accent colour and its placement (focus rings, links, running-state, caret).
- The system font stack.
- The CTA voice (button shape, border-radius, padding rhythm).
- The sidebar navigation structure.

## What pages MAY differ on
- Content-area layout (the workspace area is panel-specific).
- Use of the mono font for code/console elements.
- Presence of tabular-nums on numeric displays.
