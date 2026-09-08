const host = 'getautoclarity.com';
const key = '170f59a6dd75523c8f9318a7ae04ae2e';
const keyLocation = `https://${host}/${key}.txt`;
const urlList = [
  `https://${host}/`,
  `https://${host}/las-vegas-pre-purchase-inspection/`,
  `https://${host}/autoclarity-services.json`,
  `https://${host}/llms.txt`,
  `https://${host}/privacy`,
  `https://${host}/terms`,
];

const payload = { host, key, keyLocation, urlList };

if (!process.argv.includes('--submit')) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write('Dry run only. Add --submit after this exact build and key file are live.\n');
  process.exit(0);
}

for (const url of [keyLocation, ...urlList]) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`IndexNow preflight failed: ${url} returned ${response.status}`);
  if (response.url !== url) {
    throw new Error(`IndexNow preflight failed: ${url} resolved to unexpected URL ${response.url}`);
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (url.endsWith('.json')) {
    if (!contentType.includes('application/json')) {
      throw new Error(`IndexNow preflight failed: ${url} is not JSON (${contentType || 'missing type'})`);
    }
    const catalog = await response.json();
    if (catalog?.canonicalUrl !== 'https://getautoclarity.com/las-vegas-pre-purchase-inspection/') {
      throw new Error(`IndexNow preflight failed: ${url} does not contain the expected canonical service URL`);
    }
  } else {
    const body = await response.text();
    if (url === keyLocation) {
      if (!contentType.includes('text/plain') || body.trim() !== key) {
        throw new Error(`IndexNow preflight failed: ${url} is not the exact key file`);
      }
    } else if (url.endsWith('/llms.txt')) {
      if (!contentType.includes('text/plain') || !body.startsWith('# AutoClarity')) {
        throw new Error(`IndexNow preflight failed: ${url} is not the expected llms.txt document`);
      }
    } else if (!contentType.includes('text/html') || !body.includes('<html')) {
      throw new Error(`IndexNow preflight failed: ${url} is not an HTML document`);
    }
  }
}

const response = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(payload),
});

if (response.status !== 200 && response.status !== 202) {
  throw new Error(`IndexNow rejected the submission with HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
}

process.stdout.write(`IndexNow accepted ${urlList.length} URLs with HTTP ${response.status}.\n`);
