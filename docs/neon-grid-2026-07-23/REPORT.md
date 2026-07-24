# Neon energized-grid pointer effect — 2026-07-23

## Why the old effect was faint (root cause)

The previous "cursor glow" was a single 560px radial gradient whose peak alpha
was **0.055** (`.cursor-glow`, site.css) — an atmospheric tint deliberately
capped by the earlier "all glow alphas ≤ 11%" rule. It never touched the grid:
the technical grid (`body::after`) stayed at 2.8% alpha everywhere, so nothing
"lit up" — the pointer just carried a barely-visible blue haze.

## What was built

Two decorative fixed layers, both `pointer-events: none`, behind all content:

| Layer | Role |
|---|---|
| `.cursor-glow` (kept) | Restrained atmospheric bloom following the pointer (alpha 0.075 desktop / 0.085 touch, was 0.055/0.07). Now `z-index: -1` so it can never sit above content. |
| `.neon-grid` (new) | A second copy of the exact same 64px grid geometry drawn in vivid electric blue: crisp 1px lines at `rgba(133,200,255,0.85)` plus an 8px soft halo hugging every line (peak `rgba(96,176,255,0.34)`, recentered on the lines via −4px background-position offsets). Revealed only through a composited mask. |

The mask is rebuilt each animation frame by `main.js`: one head circle
(radius 190px desktop / 150px touch, mask alpha 0.95 → 0 at 76%) plus up to
**6 trail points** sampled every 26px of travel, each shrinking (×0.82 → ×0.30)
and fading (alpha 0.5 → 0) over its **550ms** (desktop) / **620ms** (touch)
lifetime. Because the trail points lie along the lerped head path, the reveal
reads as one fluid energized region sliding across the schematic — actual grid
lines illuminate and fade, not a flashlight blob.

## Behavior

- **Device gates (capability, not viewport width):** desktop =
  `(hover: hover) and (pointer: fine)` — any laptop qualifies at any window
  size or zoom; touch = `(pointer: coarse)`. Touchscreen-laptop touch input is
  ignored on the desktop path (`pointerType` filter); touch mode listens to
  touch events only, so post-tap synthetic mouse events can never trigger it.
- **Desktop:** responds from the first `pointermove`; `pointerenter` snaps the
  reveal to the entry point (no sweep from a stale position); lerp 0.16 —
  smooth, no jitter. After **1.7s** without movement the layer eases to a
  quiet residual (`.is-idle`, opacity 0.3) and the rAF loop stops completely;
  any movement restores full intensity instantly. Leaving the page fades
  everything out.
- **Touch:** appears under the finger on `touchstart` (position snapped, no
  sweep), follows during `touchmove` (lerp 0.3), fades over **700ms** after
  lift while the trail drains, then all work stops — nothing runs between
  touches. All listeners passive; scrolling is untouched.
- **Form safety:** focusing any `input`/`select`/`textarea`/
  `[contenteditable]`/anything inside a `<form>` fades both layers to 0 and
  blocks updates until blur.
- **Reduced motion:** neither element is ever created.
- **Page tiers:** full effect only where `<body data-fx-full>` — homepage +
  Las Vegas inspection landing. Sample report keeps bloom only. Portal,
  published report, inspector, admin: static (no main.js). Legal pages:
  light theme, no effect.

## Measured (headless Chrome, deterministic scripts)

- Desktop pointermove storm @1440: **61 fps**. Touchmove storm @390: **60 fps**.
- Swipe scroll during touch effect @390: `scrollY 97 → 697` (native scroll intact).
- Focus suppression: `.neon-grid`/`.cursor-glow` computed opacity **0/0** with
  the intake `fullName` field focused; back to 1 after blur + movement.
- Reduced motion: `.neon-grid`/`.cursor-glow` **never created**.
- Idle: `is-idle` applied, opacity settling at 0.3.
- No horizontal overflow at 320/360/375/390/414/430/768/1440 (both pages).
- No console errors.

## Evidence (`screenshots/`)

- `before-*` vs `after-*` — identical deterministic pointer paths and
  positions: `pointer-{home,inspection}-{1024,1280,1440,1920}` (settled) and
  `pointer-trail-*` (mid-motion), `touch-during-*` / `touch-faded-*` at
  320/360/375/390/414/430/768, `focus-suppressed-1280`,
  `reduced-motion-1280`.
- Recordings: `after-pointer-recording-1280.webm` (mouse sweep),
  `after-touch-recording-390.webm` (touch + fade after lift).
- Recapture: `node scripts/capture-pointer-fx.mjs docs/neon-grid-2026-07-23/screenshots <prefix> [--record]`
  (dev server on :8790; the focus-suppression step self-asserts).

## Not done (by design)

No particles, no sparks, no long comet, no blur filters, no per-frame layout
reads, no effect over text (layers sit at negative z-index), no motion under
reduced-motion, no effect on operational/legal pages.
