// Broken-link check for the local dev server (internal links + assets).
// Usage: node scripts/check-links.mjs [baseUrl]   (default http://127.0.0.1:8788)
const base = process.argv[2] ?? 'http://127.0.0.1:8788';
const pages = ['/', '/las-vegas-pre-purchase-inspection/', '/ppi/portal/', '/ppi/admin/', '/404.html', '/privacy.html', '/terms.html'];

const seen = new Set();
let failures = 0;

async function check(url, from) {
  if (seen.has(url)) return;
  seen.add(url);
  try {
    const res = await fetch(url, { redirect: 'manual' });
    const ok = res.status < 400 || res.status === 401; // auth-gated is fine
    if (!ok) {
      failures++;
      console.error(`FAIL ${res.status} ${url}   (linked from ${from})`);
    }
  } catch (e) {
    failures++;
    console.error(`FAIL ERR ${url}   (${e.message})`);
  }
}

for (const page of pages) {
  const res = await fetch(base + page);
  if (!res.ok) {
    failures++;
    console.error(`FAIL ${res.status} page ${page}`);
    continue;
  }
  const html = await res.text();
  const refs = [...html.matchAll(/(?:href|src)="([^"#]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !u.startsWith('mailto:') && !u.startsWith('data:') && !u.startsWith('javascript:'));
  for (const ref of refs) {
    if (/^https?:\/\//.test(ref)) continue; // external links not fetched in CI
    const url = base + (ref.startsWith('/') ? ref : page + ref);
    await check(url, page);
  }
  console.log(`OK   ${page} (${refs.length} refs)`);
}

console.log(failures === 0 ? `\nAll internal links OK (${seen.size} checked)` : `\n${failures} broken link(s)`);
process.exit(failures === 0 ? 0 : 1);
