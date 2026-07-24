# Premium visual depth pass — 2026-07-23

Scope: homepage + Las Vegas inspection landing page backgrounds only. Layout,
typography, copy and the customer journey are untouched (verified: before/after
full-page screenshots are structurally identical).

## What changed

| Element | Implementation |
|---|---|
| Near-black navy foundation | `--bg: #060b18 → #04070f` (site.css). Elevated surfaces (`--bg-elev-*`) unchanged → visibly stronger separation between page background and text panels. Text contrast improves (darker background, same light text). |
| Electric-blue radial glows | `body::before` — three fixed, pre-blurred radial gradients (alphas 0.06–0.11), top-left / top-right / bottom-center. No `filter: blur` → one composited layer, no scroll repaints, identical cost on phones. |
| Technical grid texture | `body::after` — 64px 1px-line grid at 2.8% alpha, radial-masked so it fades toward the page edges. Static. |
| Card edge highlights | `--shadow-card` gains a fine blue top-edge inset (`rgba(148,176,255,0.13)`) + a 1px blue inner ring at 5% — automatically applied to every card that uses the token (feature cards, mechanic card, price cards, form shell, app cards). |
| Nav underline | `.nav-links a::after` — 2px blue→cyan underline, eases in on hover/focus-visible and stays on the section currently in view (new IntersectionObserver scroll-spy in main.js adds `.is-current`). Transition gated behind `prefers-reduced-motion: no-preference`. |
| Cursor-following glow | `.cursor-glow` (created by main.js) — 560px radial at 5.5% alpha, lerped `translate3d` follow. Created **only** when: fine pointer AND viewport ≥ 941px AND motion allowed. **Fades out whenever any input/select/textarea has focus** — nothing moves while a form is being completed. `pointer-events: none`, `aria-hidden`. |

## Guardrails verified (headless Chrome, deterministic)

- **No horizontal overflow** at 320 / 360 / 375 / 390 / 414 / 430 / 768 / 1440
  on both pages (asserted programmatically during both capture runs).
- **prefers-reduced-motion: reduce** → the cursor-glow element is never
  created; underline appears without animation; reveals show instantly.
  (All "after" screenshots were captured in this mode — the static fallback
  IS the captured render.)
- **Mobile / touch** → cursor glow never created (pointer + width gates
  return false); backgrounds are static fixed layers.
- **Form focus** → glow class removed on `focusin` of any field (tested).
- **Scroll-spy** → scrolled to #pricing → the "Pricing" nav link gains the
  underline (tested).
- **Light-themed legal pages** (privacy/terms) use `legal.css` only — no
  site.css, unaffected.
- Portal/admin/inspector consume the same tokens → consistently deepened,
  no overflow (portal spot-checked at 390).

## Screenshots (`screenshots/`)

`before-*` / `after-*` × {home, inspection} × {320, 360, 375, 390, 414, 430,
768, 1440}, with full-page captures at 390 and 1440 (`*-full.png`), plus
`after-portal-390.png`. Recapture any time:

```bash
node scripts/capture-screens.mjs docs/visual-polish-2026-07-23/screenshots <prefix>
```

(Requires `npm i --no-save puppeteer-core` and desktop Chrome; plain
`chrome --headless --screenshot` clips below 500px width — don't use it.)

## Addendum — mobile touch glow (same day, follow-up commit)

Touch devices (coarse primary pointer) on the two public pages now get a
finger-following variant of the ambient glow: `.cursor-glow.is-touch`
(420px, 7% alpha, same fixed composited layer) driven by **passive**
touchstart/touchmove listeners (never preventDefault — scrolling stays
native), rAF-lerped exactly like the desktop path, and faded out by CSS over
~650ms on touchend/touchcancel — it never runs between touches. The shared
form-focus guard now also covers `[contenteditable]` and anything inside a
`<form>`. Desktop behavior unchanged (fine-pointer branch untouched;
verified). Never created under prefers-reduced-motion; never exists on
portal/report/inspector/admin/legal (they don't load main.js).

Verified via emulated touch at 320/360/375/390/393/414/430/768: glow follows
the finger, swipe scroll still scrolls, 62fps during a touchmove storm,
opacity 0 within 800ms of lift, off while a field is focused and resumes on
blur, no overflow. Evidence: `screenshots/touch-glow-{before-idle,during-touch,after-fade}-390.png`
+ `touch-glow-interaction-390.webm`.

## Superseded (same day, later session)

The cursor/touch ambient glow described above was upgraded to the **neon
energized-grid effect** — the grid lines themselves now illuminate around the
pointer/finger with a fading trail. Root cause of the faintness, new
architecture, measurements and evidence: `docs/neon-grid-2026-07-23/REPORT.md`.
The guardrails in this report (reduced motion, form-focus suppression, no
overflow, page tiers) all still hold and were re-verified there.

## Deliberately NOT done

No particles, no animated gradients, no neon saturation, no flashing, no
parallax, no motion during scroll — the effect targets "precision
instrument", not "gaming rig". All glow alphas ≤ 11%.
