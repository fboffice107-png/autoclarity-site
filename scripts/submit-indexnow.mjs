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
