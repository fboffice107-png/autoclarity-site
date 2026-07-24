// Screenshot both public pages at the audit widths (DPR 2 for phones).
// Usage: node capture.mjs <outdir> <prefix>
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const [outdir, prefix] = process.argv.slice(2);
mkdirSync(outdir, { recursive: true });

const BASE = 'http://localhost:8790';
const PAGES = [
  { name: 'home', url: `${BASE}/` },
  { name: 'inspection', url: `${BASE}/las-vegas-pre-purchase-inspection/` },
];
const WIDTHS = [320, 360, 375, 390, 414, 430, 768, 1440];
const FULLPAGE = new Set([390, 1440]); // full-page at two representative widths

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
});
const page = await browser.newPage();
// Disable reveal animations so captures are deterministic.
await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);

const overflows = [];
for (const p of PAGES) {
  for (const w of WIDTHS) {
    const dpr = w < 768 ? 2 : 1;
    await page.setViewport({ width: w, height: w < 768 ? 844 : 900, deviceScaleFactor: dpr });
    await page.goto(p.url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 400));
    const m = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    if (m.scrollWidth > m.innerWidth) overflows.push(`${p.name}@${w}: scrollWidth ${m.scrollWidth} > ${m.innerWidth}`);
    const full = FULLPAGE.has(w);
    await page.screenshot({ path: `${outdir}/${prefix}-${p.name}-${w}${full ? '-full' : ''}.png`, fullPage: full });
  }
}
await browser.close();
if (overflows.length) {
  console.error('HORIZONTAL OVERFLOW:\n' + overflows.join('\n'));
  process.exit(1);
}
console.log('captured, no horizontal overflow at any width');
