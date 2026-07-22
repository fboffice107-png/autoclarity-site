// Boots the full local stack for integration tests:
//  1. wipes local wrangler state (fresh D1/R2 every run)
//  2. applies migrations
//  3. starts a mock Stripe API on :8798
//  4. starts `wrangler pages dev` on :8799 with test bindings
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import http from 'node:http';

export const BASE = 'http://127.0.0.1:8799';
export const ADMIN_KEY = 'test-admin-key-0123456789abcdef';
export const WEBHOOK_SECRET = 'whsec_integration_test_secret';

let wranglerProc: ChildProcess | null = null;
let mockStripe: http.Server | null = null;

export default async function setup() {
  // 1. fresh local state
  rmSync('.wrangler/state', { recursive: true, force: true });

  // 2. migrations
  execSync('npx wrangler d1 migrations apply autoclarity_ppi --local', { stdio: 'pipe' });

  // 3. mock Stripe
  let sessionCounter = 0;
  let lastSessionParams: Record<string, string> = {};
  mockStripe = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
        lastSessionParams = Object.fromEntries(new URLSearchParams(body));
        sessionCounter++;
        res.end(
          JSON.stringify({
            id: `cs_mock_${sessionCounter}`,
            url: `http://127.0.0.1:8798/pay/cs_mock_${sessionCounter}`,
            expires_at: Math.floor(Date.now() / 1000) + 1800,
          }),
        );
      } else if (req.method === 'POST' && req.url === '/v1/refunds') {
        res.end(JSON.stringify({ id: 're_mock_1', status: 'succeeded' }));
      } else if (req.method === 'GET' && req.url === '/last-session') {
        res.end(JSON.stringify(lastSessionParams));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { message: 'mock: not found' } }));
      }
    });
  });
  await new Promise<void>((resolve) => mockStripe!.listen(8798, '127.0.0.1', resolve));

  // 4. wrangler pages dev with test bindings
  const bindings = {
    PPI_ENV: 'preview',
    PPI_MODE: 'request',
    PAYMENTS_ENABLED: 'true',
    STRIPE_ENV: 'test',
    BOOKING_ENABLED: 'true',
    UPLOADS_ENABLED: 'true',
    PUBLIC_BASE_URL: BASE,
    ADMIN_DEV_KEY: ADMIN_KEY,
    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
    STRIPE_SECRET_KEY: 'sk_test_integration_mock',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_API_BASE: 'http://127.0.0.1:8798/v1',
  };
  const args = ['wrangler', 'pages', 'dev', '.', '--port', '8799'];
  for (const [k, v] of Object.entries(bindings)) args.push('--binding', `${k}=${v}`);

  wranglerProc = spawn('npx', args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let bootLog = '';
  wranglerProc.stdout?.on('data', (d) => (bootLog += d));
  wranglerProc.stderr?.on('data', (d) => (bootLog += d));

  // readiness poll
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/ppi/runtime-config`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      throw new Error(`wrangler pages dev did not become ready.\n--- boot log ---\n${bootLog.slice(-4000)}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  return async () => {
    if (wranglerProc?.pid) {
      try {
        process.kill(-wranglerProc.pid, 'SIGTERM');
      } catch {
        wranglerProc.kill('SIGTERM');
      }
    }
    await new Promise<void>((resolve) => (mockStripe ? mockStripe.close(() => resolve()) : resolve()));
  };
}
