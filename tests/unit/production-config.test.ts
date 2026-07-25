// Guards the shipped production configuration itself. Live Stripe stays off
// until the owner deliberately turns it on, so these assertions must be
// changed by hand — they cannot drift silently.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd(); // vitest runs from the repository root
const wranglerToml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8');

function varValue(name: string): string | null {
  const m = wranglerToml.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm'));
  return m ? (m[1] ?? null) : null;
}

describe('production configuration keeps live payments disabled', () => {
  it('ships PAYMENTS_ENABLED=false', () => {
    expect(varValue('PAYMENTS_ENABLED')).toBe('false');
  });

  it('ships STRIPE_ENV=test', () => {
    expect(varValue('STRIPE_ENV')).toBe('test');
  });

  it('is in request mode, not live mode', () => {
    expect(varValue('PPI_MODE')).toBe('request');
  });

  it('never contains a Stripe secret, live or test', () => {
    expect(wranglerToml).not.toMatch(/\b(sk|rk)_live_[A-Za-z0-9]/);
    expect(wranglerToml).not.toMatch(/\b(sk|rk)_test_[A-Za-z0-9]/);
    expect(wranglerToml).not.toMatch(/\bwhsec_[A-Za-z0-9]/);
  });
});

describe('no live Stripe credential exists anywhere in the tracked source', () => {
  const SKIP_DIRS = new Set(['node_modules', '.git', '.wrangler', 'assets/img']);
  const TEXT = /\.(ts|js|mjs|json|html|css|md|sql|toml|sh|py|yml|yaml)$/;

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = full.slice(ROOT.length + 1);
      if (SKIP_DIRS.has(entry) || SKIP_DIRS.has(rel)) continue;
      if (statSync(full).isDirectory()) walk(full, out);
      else if (TEXT.test(entry)) out.push(full);
    }
    return out;
  }

  it('contains no sk_live_ / rk_live_ key material', () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const body = readFileSync(file, 'utf8');
      // The literal prefixes appear in safety checks and docs; a real key has
      // key material after the prefix.
      if (/\b(sk|rk)_live_[A-Za-z0-9]{8,}/.test(body)) offenders.push(file.slice(ROOT.length + 1));
    }
    expect(offenders).toEqual([]);
  });
});
