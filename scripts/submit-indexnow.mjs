import { pathToFileURL } from 'node:url';

const host = 'getautoclarity.com';
const key = '170f59a6dd75523c8f9318a7ae04ae2e';
const expectedBuild = 'ac-ai-20260908-r1';
const keyLocation = `https://${host}/${key}.txt`;
const urlList = [
  `https://${host}/`,
  `https://${host}/las-vegas-pre-purchase-inspection/`,
  `https://${host}/las-vegas-pre-purchase-inspection/sample-report/`,
  `https://${host}/autoclarity-services.json`,
  `https://${host}/llms.txt`,
  `https://${host}/privacy`,
  `https://${host}/terms`,
];

const payload = { host, key, keyLocation, urlList };

export async function verifyIndexNowTargets(fetchImpl = fetch) {
  for (const url of [keyLocation, ...urlList]) {
    const response = await fetchImpl(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`IndexNow preflight failed: ${url} returned ${response.status}`);
    if (response.url !== url) {
      throw new Error(`IndexNow preflight failed: ${url} resolved to unexpected URL ${response.url}`);
    }
    if (response.headers.get('x-autoclarity-build') !== expectedBuild) {
      throw new Error(`IndexNow preflight failed: ${url} is not served by build ${expectedBuild}`);
    }
    if (/\bnoindex\b/iu.test(response.headers.get('x-robots-tag') ?? '')) {
      throw new Error(`IndexNow preflight failed: ${url} is marked noindex`);
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (url.endsWith('.json')) {
      if (!contentType.includes('application/json')) {
        throw new Error(`IndexNow preflight failed: ${url} is not JSON (${contentType || 'missing type'})`);
      }
      const catalog = await response.json();
      if (catalog?.canonicalUrl !== url) {
        throw new Error(`IndexNow preflight failed: ${url} does not identify itself as the canonical catalog`);
      }
      const ppiOffering = Array.isArray(catalog?.offerings)
        ? catalog.offerings.find((offering) => offering?.id === 'las-vegas-pre-purchase-inspection')
        : undefined;
      if (ppiOffering?.officialPage !== 'https://getautoclarity.com/las-vegas-pre-purchase-inspection/') {
        throw new Error(`IndexNow preflight failed: ${url} does not contain the expected canonical service offering`);
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
      } else {
        const expectedCanonical = `<link rel="canonical" href="${url}"`;
        if (!contentType.includes('text/html') || !body.includes('<html')) {
          throw new Error(`IndexNow preflight failed: ${url} is not an HTML document`);
        }
        if (!body.includes(expectedCanonical)) {
          throw new Error(`IndexNow preflight failed: ${url} does not contain its exact canonical URL`);
        }
      }
    }
  }
}

export async function submitIndexNow(fetchImpl = fetch) {
  await verifyIndexNowTargets(fetchImpl);
  const response = await fetchImpl('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });

  if (response.status !== 200 && response.status !== 202) {
    throw new Error(`IndexNow rejected the submission with HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  return response.status;
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedAsScript) {
  if (!process.argv.includes('--submit')) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.stdout.write('Dry run only. Add --submit after this exact build and key file are live.\n');
  } else {
    const status = await submitIndexNow();
    process.stdout.write(`IndexNow accepted ${urlList.length} URLs with HTTP ${status}.\n`);
  }
}
