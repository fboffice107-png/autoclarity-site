import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyIndexNowTargets } from './submit-indexnow.mjs';

const base = 'https://getautoclarity.com';
const build = 'ac-ai-20260907-r2';
const files = new Map([
  [`${base}/`, await readFile(new URL('../index.html', import.meta.url), 'utf8')],
  [`${base}/las-vegas-pre-purchase-inspection/`, await readFile(new URL('../las-vegas-pre-purchase-inspection/index.html', import.meta.url), 'utf8')],
  [`${base}/autoclarity-services.json`, await readFile(new URL('../autoclarity-services.json', import.meta.url), 'utf8')],
  [`${base}/llms.txt`, await readFile(new URL('../llms.txt', import.meta.url), 'utf8')],
  [`${base}/privacy`, await readFile(new URL('../privacy.html', import.meta.url), 'utf8')],
  [`${base}/terms`, await readFile(new URL('../terms.html', import.meta.url), 'utf8')],
  [`${base}/170f59a6dd75523c8f9318a7ae04ae2e.txt`, await readFile(new URL('../170f59a6dd75523c8f9318a7ae04ae2e.txt', import.meta.url), 'utf8')],
]);

function fixture(url, overrides = {}) {
  const body = overrides.body ?? files.get(url);
  assert.equal(typeof body, 'string', `Missing IndexNow fixture for ${url}`);
  const contentType = url.endsWith('.json')
    ? 'application/json; charset=utf-8'
    : (url.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8');
  return {
    ok: true,
    status: 200,
    url,
    headers: new Headers({
      'content-type': contentType,
      'x-autoclarity-build': overrides.build ?? build,
      ...(overrides.robots ? { 'x-robots-tag': overrides.robots } : {}),
    }),
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

await verifyIndexNowTargets(async (url) => fixture(String(url)));

await assert.rejects(
  verifyIndexNowTargets(async (url) => fixture(String(url), String(url) === `${base}/` ? { build: 'ac-prod-20260903-r3' } : {})),
  /is not served by build/u,
);

await assert.rejects(
  verifyIndexNowTargets(async (url) => fixture(String(url), String(url) === `${base}/` ? { robots: 'noindex, nofollow' } : {})),
  /is marked noindex/u,
);

await assert.rejects(
  verifyIndexNowTargets(async (url) => fixture(String(url), String(url) === `${base}/privacy` ? { body: files.get(`${base}/`) } : {})),
  /exact canonical URL/u,
);

const wrongCatalog = JSON.parse(files.get(`${base}/autoclarity-services.json`));
wrongCatalog.offerings.find((offering) => offering.id === 'las-vegas-pre-purchase-inspection').officialPage = `${base}/`;
await assert.rejects(
  verifyIndexNowTargets(async (url) => fixture(String(url), String(url).endsWith('.json') ? { body: JSON.stringify(wrongCatalog) } : {})),
  /canonical service offering/u,
);

process.stdout.write('IndexNow behavioral preflight checks passed.\n');
