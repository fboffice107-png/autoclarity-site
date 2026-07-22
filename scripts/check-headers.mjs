// Security-header smoke check against a running deployment.
// Usage: node scripts/check-headers.mjs [baseUrl]
// NOTE: `wrangler pages dev` serves _headers like production Pages does, so
// this works locally too.
const base = process.argv[2] ?? 'http://127.0.0.1:8788';
let failures = 0;

function expect(name, headers, page, pattern) {
  const value = headers.get(name);
  if (!value || (pattern && !pattern.test(value))) {
    failures++;
    console.error(`FAIL ${page}: ${name} = ${value ?? '(missing)'}`);
  } else {
    console.log(`OK   ${page}: ${name}`);
  }
}

// Static pages: _headers rules
for (const page of ['/las-vegas-pre-purchase-inspection/', '/ppi/portal/']) {
  const res = await fetch(base + page);
  expect('x-content-type-options', res.headers, page, /nosniff/);
  expect('x-frame-options', res.headers, page, /DENY/i);
  expect('referrer-policy', res.headers, page, /strict-origin/);
  expect('content-security-policy', res.headers, page, /default-src 'self'/);
  expect('permissions-policy', res.headers, page, /microphone=\(\)/);
}

// API: middleware headers
{
  const res = await fetch(base + '/api/ppi/runtime-config');
  expect('cache-control', res.headers, '/api/ppi/runtime-config', /no-store/);
  expect('x-robots-tag', res.headers, '/api/ppi/runtime-config', /noindex/);
  expect('x-content-type-options', res.headers, '/api/ppi/runtime-config', /nosniff/);
}

// Redirects
for (const [from, to] of [['/ppi', '/las-vegas-pre-purchase-inspection/'], ['/pre-purchase-inspection', '/las-vegas-pre-purchase-inspection/']]) {
  const res = await fetch(base + from, { redirect: 'manual' });
  if (res.status === 301 && (res.headers.get('location') ?? '').includes(to)) {
    console.log(`OK   redirect ${from} -> ${to}`);
  } else {
    failures++;
    console.error(`FAIL redirect ${from}: status ${res.status}, location ${res.headers.get('location')}`);
  }
}

console.log(failures === 0 ? '\nAll header checks passed' : `\n${failures} header check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
