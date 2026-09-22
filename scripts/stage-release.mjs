// Offline packaging only. This script cannot deploy or apply migrations.
// Usage: node scripts/stage-release.mjs EXACT_COMMIT NEW_ABSOLUTE_OUTPUT_DIR
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const [expected, output] = process.argv.slice(2);
const git = (...args) => execFileSync('git', args, { maxBuffer: 32 * 1024 * 1024 });
const root = git('rev-parse', '--show-toplevel').toString().trim();
process.chdir(root);
if (!/^[0-9a-f]{40}$/.test(expected || '') || git('rev-parse', 'HEAD').toString().trim() !== expected) throw Error('Exact HEAD commit required.');
if (git('status', '--porcelain').toString().trim()) throw Error('Working tree must be clean.');
const outside = output ? relative(root, resolve(output)) : '';
if (!output || !isAbsolute(output) || existsSync(output) || !(outside === '..' || outside.startsWith('../'))) throw Error('Use a new absolute output directory outside the repository.');
mkdirSync(output, { recursive: false, mode: 0o700 });
const publicDir = join(output, 'public');
mkdirSync(publicDir);
const rootAssets = new Set(['170f59a6dd75523c8f9318a7ae04ae2e.txt', '404.html', '_headers', '_redirects', 'autoclarity-services.json', 'icon.png', 'index.html', 'llms.txt', 'privacy.html', 'robots.txt', 'sitemap.xml', 'terms.html']);
const sourceFiles = git('ls-tree', '-r', '--name-only', expected).toString().trim().split('\n');
const hash = b => createHash('sha256').update(b).digest('hex');
const lock = JSON.parse(git('show', `${expected}:package-lock.json`));
const compilerVersions = {};
for (const name of ['wrangler', 'esbuild']) {
  const installed = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'))).version;
  if (installed !== lock.packages[`node_modules/${name}`]?.version) throw Error(`Compiler does not match lockfile: ${name}`);
  compilerVersions[name] = installed;
}
const sources = [];
for (const path of sourceFiles) {
  const deployable = rootAssets.has(path) || /^(assets|ppi|las-vegas-pre-purchase-inspection|pre-purchase-inspection)\//.test(path);
  if (!deployable || path === 'assets/img/faheb-founder-original.png' || path.split('/').some(p => p.startsWith('.'))) continue;
  const bytes = git('show', `${expected}:${path}`);
  const target = join(publicDir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  sources.push({ path, bytes: bytes.length, sha256: hash(bytes) });
}
// Compile isolated exact git objects, never a concurrently edited worktree.
const buildSource = join(output, 'build-source');
for (const path of sourceFiles.filter(p => p.startsWith('functions/'))) {
  const target = join(buildSource, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, git('show', `${expected}:${path}`));
}
// Version-checked local compiler; no deployment config or credentials copied.
// --outfile emits a multipart upload body in this Wrangler version, not an
// executable script. Pages advanced mode accepts the module directory below.
execFileSync(join(root, 'node_modules/.bin/wrangler'), ['pages', 'functions', 'build', 'functions', '--outdir', join(publicDir, '_worker.js'), '--output-routes-path', join(publicDir, '_routes.json'), '--compatibility-date', '2026-07-01'], { cwd: buildSource, stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(output, 'compiler.log') } });
execFileSync(process.execPath, ['--check', join(publicDir, '_worker.js/index.js')], { stdio: 'pipe' });
const files = [];
function inventory(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) inventory(path);
    else { const bytes = readFileSync(path); files.push({ path: relative(publicDir, path), bytes: bytes.length, sha256: hash(bytes) }); }
  }
}
inventory(publicDir);
const migrations = [];
// The migrations THIS release adds on top of what production already has
// (0001-0012 applied). Update both lines together when a release adds one.
const migrationPaths = sourceFiles.filter(p => /^migrations\/001[456]_.*\.sql$/.test(p));
const expectedMigrations = ['migrations/0014_booking_proposal_flow.sql', 'migrations/0015_open_availability.sql', 'migrations/0016_record_kind.sql'];
if (JSON.stringify(migrationPaths) !== JSON.stringify(expectedMigrations)) throw Error('Unexpected final migration set.');
for (const path of migrationPaths) {
  const bytes = git('show', `${expected}:${path}`);
  mkdirSync(join(output, 'migrations'), { recursive: true });
  writeFileSync(join(output, path), bytes);
  migrations.push({ path, sha256: hash(bytes) });
}
const manifest = { commit: expected, tree: git('rev-parse', `${expected}^{tree}`).toString().trim(), build: 'ac-ai-20260911-r1', compilerVersions, publicDirectory: publicDir, files, staticSources: sources, functionSources: sourceFiles.filter(p => p.startsWith('functions/')).map(path => ({ path, sha256: hash(git('show', `${expected}:${path}`)) })), migrations, warning: 'LOCAL ARTIFACT ONLY. No deployment or production migration has occurred.' };
writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ commit: expected, publicFiles: files.length, migrations: migrations.length, manifest: join(output, 'manifest.json'), manifestSha256: hash(readFileSync(join(output, 'manifest.json'))) }, null, 2));
