# Dashboard palette

The dashboard uses Nord neutrals with the logo's forge orange as the only accent. Light or dark follows the operator's OS setting, and there is no manual toggle.

The values live in the `@theme` block of `runtime/packages/frontend/src/styles.css` and the rules live here. A palette change updates both.

## Tokens

Each token is a Tailwind colour that switches between its light and dark value by itself, through CSS `light-dark()`. Templates use the token (`bg-surface`, `text-muted`) and never a `dark:` variant. Tailwind's default palette is switched off, so these are the only colours a template can reach.

| Token | Light | Dark | Use |
|---|---|---|---|
| bg | #ECEFF4 | #2E3440 | Page background, hovered table rows, the inset body of a subagent |
| surface | #FFFFFF | #3B4252 | Header, cards, tables and transcript cards |
| raised | #F5F7FA | #434C5E | Table header band, running pill, tool argument and result blocks |
| line | #D8DEE9 | #4C566A | Borders and dividers. A subagent report's card border is `fg` at 35% instead |
| fg | #2E3440 | #ECEFF4 | Body text |
| muted | #4C566A | #AEB7C7 | Secondary text, pending costs, inactive nav |
| accent | #F26B1D | #F26B1D | Decoration only: active nav underline, focus rings, the logo |
| accent-text | #AE4A0A | #F79A63 | Links |
| accent-soft | #FDE7DA | #4A3A35 | Reserved for an accent tint |
| success / success-soft | #3F6B2B / #E4EEDC | #A3BE8C / #3E4A42 | Success pill |
| error / error-soft | #A8404B / #F6E1E3 | #EE9CA3 / #4D3D46 | Error pill and badge, poll and run error callouts, the border and label of a failed tool, error message or failed result |
| warning / warning-soft | #8A6512 / #F8EED6 | #EBCB8B / #4B4843 | Unconfirmed badge |
| series-1 | #3B6EA8 | #88C0D0 | Insights chart: first cohort, provider |
| series-2 | #B0563B | #D08770 | Insights chart: second cohort, provider |
| series-3 | #2F7F6F | #8FBCBB | Insights chart: third cohort, provider |
| series-4 | #7B5A9E | #B48EAD | Insights chart: fourth cohort, provider |
| series-5 | #8A6512 | #EBCB8B | Insights chart: fifth cohort, provider |
| series-6 | #4F7D2D | #A3BE8C | Insights chart: sixth cohort, provider |

## Usage rules

- Raw forge orange (`accent`) is only decoration: the active nav underline, focus rings and the logo. It is never used for text.
- Links use `accent-text`.
- Status colours stay separate from the accent. Success is green, error is red, and unconfirmed is a yellow badge. Pending is muted italic, running is a grey pill, and a queued ticket is a `muted` pill outlined in `line` on the surface.
- Every text colour passes WCAG AA (4.5:1) against the surface it sits on. The ratios below say which pairings that allows. In dark mode `muted` and `accent-text` fall below AA on `raised`, so `raised` only ever carries `fg` text, and hovered rows turn `bg` rather than `raised`.
- Every focusable element shows a 2px `accent` outline when focused from the keyboard.
- Series colours tell cohorts and providers apart on the Insights page, assigned in order and reused after the sixth. They are graphics only, never text, and the unknown-config cohort uses `muted`. A point's outcome is carried by its shape, never by colour, so status colours stay out of charts. The shapes are a filled circle for merged, a filled diamond for opened (a pull request opened, merged or not), a cross for failed (no pull request), and a hollow square for a manual workload, which has no outcome.
- Fonts are the native stacks: system UI for text and UI monospace for code.

## Contrast ratios

WCAG 2 contrast ratios of each text colour against the surfaces in the palette. A pairing below 4.5:1 is not used for text.

| Text | On | Light | Dark |
|---|---|---|---|
| fg | bg | 10.84 | 10.84 |
| fg | surface | 12.49 | 8.73 |
| fg | raised | 11.64 | 7.49 |
| muted | bg | 6.40 | 6.18 |
| muted | surface | 7.38 | 4.98 |
| muted | raised | 6.87 | 4.27, not used |
| accent-text | bg | 4.82 | 5.80 |
| accent-text | surface | 5.55 | 4.68 |
| accent-text | raised | 5.17 | 4.01, not used |
| success | success-soft | 5.24 | 4.55 |
| error | error-soft | 4.80 | 4.79 |
| error | surface | 6.00 | 4.75 |
| error | bg | 5.21 | 5.90 |
| warning | warning-soft | 4.60 | 5.83 |

Each series colour measures at least 4.46 (light) against `surface` and `raised`, and 3.54 (dark) against `surface`, above the 3:1 WCAG asks of graphics.

`accent` is never text. As decoration it measures 2.64 (light) and 4.10 (dark) against `bg`, and 3.05 (light) and 3.30 (dark) against `surface`.
