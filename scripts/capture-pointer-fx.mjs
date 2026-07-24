// Pointer/touch-effect evidence captures for the neon grid work.
// Deterministic: identical pointer paths and timings for before/after runs.
// Usage: node scripts/capture-pointer-fx.mjs <outdir> <prefix> [--record]
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const [outdir, prefix, ...flags] = process.argv.slice(2);
const RECORD = flags.includes('--record');
mkdirSync(outdir, { recursive: true });

const BASE = 'http://localhost:8790';
const PAGES = [
  { name: 'home', url: `${BASE}/` },
  { name: 'inspection', url: `${BASE}/las-vegas-pre-purchase-inspection/` },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
});

// ---------- Desktop pointer: fixed path ending at a fixed position ----------
const DESKTOP_WIDTHS = [1024, 1280, 1440, 1920];
for (const p of PAGES) {
  for (const w of DESKTOP_WIDTHS) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: 860, deviceScaleFactor: 1 });
    await page.goto(p.url, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(500);
    // Same normalized path every run: sweep in, settle at (0.5w, 420).
    const path = [
      [0.15, 620], [0.25, 560], [0.38, 500], [0.5, 460], [0.5, 420],
    ];
    for (const [fx, y] of path) {
      await page.mouse.move(Math.round(w * fx), y, { steps: 8 });
      await sleep(60);
    }
    await sleep(120); // lerp settles; trail newest points still visible
    await page.screenshot({ path: `${outdir}/${prefix}-pointer-${p.name}-${w}.png` });
    // Mid-motion capture (trail visible): move again and shoot immediately.
    await page.mouse.move(Math.round(w * 0.72), 300, { steps: 14 });
    await page.screenshot({ path: `${outdir}/${prefix}-pointer-trail-${p.name}-${w}.png` });
    await page.close();
  }
}

// ---------- Desktop: form focus suppression + reduced motion ----------
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });
  await page.goto(`${BASE}/las-vegas-pre-purchase-inspection/`, { waitUntil: 'networkidle2' });
  await sleep(400);
  await page.mouse.move(640, 420, { steps: 6 });
  await sleep(300);
  // Focus a VISIBLE field (the intake form is multi-step; the first input in
  // DOM order can be inside a hidden step, where .focus() silently no-ops).
  const focusedInfo = await page.evaluate(() => {
    const els = [...document.querySelectorAll('input, select, textarea')];
    const vis = els.find((el) => el.offsetParent && !el.disabled);
    if (!vis) return null;
    vis.focus();
    return { tag: vis.tagName, id: vis.id || vis.name || '(anon)', active: document.activeElement === vis };
  });
  console.log('focus-suppression field:', JSON.stringify(focusedInfo));
  await sleep(700); // fade-out completes
  const fxState = await page.evaluate(() => {
    const n = document.querySelector('.neon-grid');
    const g = document.querySelector('.cursor-glow');
    return {
      neonOpacity: n ? getComputedStyle(n).opacity : 'absent',
      glowOpacity: g ? getComputedStyle(g).opacity : 'absent',
    };
  });
  console.log('focus-suppression fx opacity (must be 0/0):', JSON.stringify(fxState));
  if (focusedInfo && focusedInfo.active && (parseFloat(fxState.neonOpacity) > 0.01 || parseFloat(fxState.glowOpacity) > 0.01)) {
    console.error('FOCUS SUPPRESSION FAILED');
    process.exit(1);
  }
  await page.screenshot({ path: `${outdir}/${prefix}-focus-suppressed-1280.png` });
  await page.close();

  const rm = await browser.newPage();
  await rm.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await rm.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });
  await rm.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  await sleep(400);
  await rm.mouse.move(640, 420, { steps: 6 });
  await sleep(400);
  const fxEls = await rm.evaluate(() => ({
    glow: !!document.querySelector('.cursor-glow'),
    neon: !!document.querySelector('.neon-grid'),
  }));
  console.log('reduced-motion fx elements (must be false/false):', JSON.stringify(fxEls));
  await rm.screenshot({ path: `${outdir}/${prefix}-reduced-motion-1280.png` });
  await rm.close();
}

// ---------- Touch: finger-follow + fade after lift + scroll intact ----------
const TOUCH_WIDTHS = [320, 360, 375, 390, 414, 430, 768];
for (const w of TOUCH_WIDTHS) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: 844, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(400);
  const cdp = await page.createCDPSession();
  const touch = (type, x, y) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    });
  await touch('touchStart', w * 0.5, 500);
  for (let i = 0; i <= 6; i++) {
    await touch('touchMove', w * (0.5 - i * 0.04), 500 - i * 18);
    await sleep(40);
  }
  await page.screenshot({ path: `${outdir}/${prefix}-touch-during-${w}.png` });
  await touch('touchEnd', 0, 0);
  await sleep(1100); // past the fade window
  await page.screenshot({ path: `${outdir}/${prefix}-touch-faded-${w}.png` });

  if (w === 390) {
    // Scroll must remain native: swipe up and verify the page scrolled.
    const y0 = await page.evaluate(() => window.scrollY);
    await cdp.send('Input.synthesizeScrollGesture', { x: 195, y: 500, xDistance: 0, yDistance: -600, speed: 1200 });
    await sleep(500);
    const y1 = await page.evaluate(() => window.scrollY);
    console.log(`scroll check @390: scrollY ${y0} -> ${y1} (must increase)`);
    if (y1 <= y0) { console.error('SCROLL BROKEN'); process.exit(1); }
    // FPS during a touchmove storm.
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(300);
    await touch('touchStart', 195, 500);
    const fpsPromise = page.evaluate(() => new Promise((res) => {
      let frames = 0; const t0 = performance.now();
      function tick() { frames++; if (performance.now() - t0 < 1500) requestAnimationFrame(tick); else res(Math.round(frames / 1.5)); }
      requestAnimationFrame(tick);
    }));
    for (let i = 0; i < 30; i++) {
      await touch('touchMove', 100 + (i % 10) * 18, 300 + (i % 7) * 40);
      await sleep(45);
    }
    const fps = await fpsPromise;
    await touch('touchEnd', 0, 0);
    console.log(`touchmove-storm FPS @390: ${fps}`);
  }
  await page.close();
}

// ---------- Optional recordings ----------
if (RECORD) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  await sleep(400);
  const rec = await page.screencast({ path: `${outdir}/${prefix}-pointer-recording-1280.webm` });
  const sweep = [
    [200, 620], [420, 520], [700, 430], [980, 380], [700, 560], [420, 640], [640, 420],
  ];
  for (const [x, y] of sweep) { await page.mouse.move(x, y, { steps: 18 }); await sleep(140); }
  await sleep(900);
  await rec.stop();
  await page.close();

  const tp = await browser.newPage();
  await tp.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await tp.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  await sleep(400);
  const cdp2 = await tp.createCDPSession();
  const touch2 = (type, x, y) => cdp2.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const rec2 = await tp.screencast({ path: `${outdir}/${prefix}-touch-recording-390.webm` });
  await touch2('touchStart', 195, 560);
  const sweep2 = [[160, 520], [140, 460], [180, 400], [240, 360], [260, 430], [200, 500]];
  for (const [x, y] of sweep2) { await touch2('touchMove', x, y); await sleep(120); }
  await touch2('touchEnd', 0, 0);
  await sleep(1200);
  await rec2.stop();
  await tp.close();
}

await browser.close();
console.log('pointer-fx captures complete:', outdir, prefix);
