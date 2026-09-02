// Boots the full local stack for integration tests:
//  1. wipes local wrangler state (fresh D1/R2 every run)
//  2. applies migrations
//  3. starts a mock Stripe API on :8798
//  4. starts `wrangler pages dev` on :8799 with test bindings
import { spawn, execFileSync, execSync, type ChildProcess } from 'node:child_process';
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
  execSync('npx wrangler d1 migrations apply autoclarity_ppi --config wrangler.local.toml --local', { stdio: 'pipe' });

  // 3. mock Stripe
  let sessionCounter = 0;
  let lastSessionParams: Record<string, string> = {};
  let lastSessionIdempotencyKey = '';
  type MockCheckoutSession = {
    id: string;
    url: string;
    expires_at: number;
    status?: string;
    eventObject: Record<string, unknown>;
  };
  type RefundControlStatus = 'pending' | 'succeeded' | 'requires_action' | 'failed' | 'canceled' | 'unknown';
  const sessionsByIdempotencyKey = new Map<string, MockCheckoutSession>();
  const sessionsById = new Map<string, MockCheckoutSession>();
  const expiredSessions: string[] = [];
  const refundRequests: Array<{
    body: string;
    idempotencyKey: string;
    responseId: string;
    responseStatus: string;
    responseCreated: number;
  }> = [];
  let delayNextCheckout = false;
  let waitingCheckout: { response: http.ServerResponse; session: MockCheckoutSession } | null = null;
  let delayNextExpire = false;
  let waitingExpire: { response: http.ServerResponse; session: MockCheckoutSession } | null = null;
  let nextRefundStatus: RefundControlStatus | null = null;

  const releaseWaitingCheckout = (): boolean => {
    const waiting = waitingCheckout;
    waitingCheckout = null;
    if (!waiting) return false;
    if (!waiting.response.writableEnded && !waiting.response.destroyed) {
      waiting.response.end(JSON.stringify(waiting.session));
    }
    return true;
  };

  const releaseWaitingExpire = (): boolean => {
    const waiting = waitingExpire;
    waitingExpire = null;
    if (!waiting) return false;
    if (!waiting.response.writableEnded && !waiting.response.destroyed) {
      waiting.response.end(JSON.stringify({ ...waiting.session, status: 'expired' }));
    }
    return true;
  };

  mockStripe = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
        lastSessionParams = Object.fromEntries(new URLSearchParams(body));
        lastSessionIdempotencyKey = String(req.headers['idempotency-key'] ?? '');
        let session = lastSessionIdempotencyKey ? sessionsByIdempotencyKey.get(lastSessionIdempotencyKey) : undefined;
        if (!session) {
          sessionCounter++;
          session = {
            id: `cs_mock_${sessionCounter}`,
            url: `http://127.0.0.1:8798/pay/cs_mock_${sessionCounter}`,
            expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
            eventObject: {
              id: `cs_mock_${sessionCounter}`,
              payment_status: 'paid',
              amount_total: Number(lastSessionParams['line_items[0][price_data][unit_amount]']),
              currency: lastSessionParams['line_items[0][price_data][currency]'],
              client_reference_id: lastSessionParams['client_reference_id'],
              metadata: {
                request_id: lastSessionParams['metadata[request_id]'],
                quote_id: lastSessionParams['metadata[quote_id]'],
                booking_id: lastSessionParams['metadata[booking_id]'],
              },
            },
          };
          if (lastSessionIdempotencyKey) sessionsByIdempotencyKey.set(lastSessionIdempotencyKey, session);
          sessionsById.set(session.id, session);
        }
        if (delayNextCheckout) {
          delayNextCheckout = false;
          const waiting = { response: res, session };
          waitingCheckout = waiting;
          res.once('close', () => {
            if (waitingCheckout === waiting) waitingCheckout = null;
          });
          return;
        }
        res.end(JSON.stringify(session));
      } else if (req.method === 'POST' && /^\/v1\/checkout\/sessions\/cs_[A-Za-z0-9_]+\/expire$/.test(req.url ?? '')) {
        const sessionId = String(req.url).split('/').at(-2)!;
        const session = sessionsById.get(sessionId);
        if (!session || session.status === 'complete') {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: 'mock: session cannot be expired' } }));
          return;
        }
        session.status = 'expired';
        expiredSessions.push(sessionId);
        if (delayNextExpire) {
          delayNextExpire = false;
          const waiting = { response: res, session };
          waitingExpire = waiting;
          res.once('close', () => {
            if (waitingExpire === waiting) waitingExpire = null;
          });
          return;
        }
        res.end(JSON.stringify({ ...session, status: 'expired' }));
      } else if (req.method === 'POST' && req.url === '/v1/refunds') {
        const refundParams = new URLSearchParams(body);
        const selectedStatus = nextRefundStatus ?? 'succeeded';
        nextRefundStatus = null;
        const responseStatus = selectedStatus === 'unknown' ? 'future_refund_status' : selectedStatus;
        const responseId = `re_mock_${refundRequests.length + 1}`;
        const responseCreated = Math.floor(Date.now() / 1000);
        refundRequests.push({
          body,
          idempotencyKey: String(req.headers['idempotency-key'] ?? ''),
          responseId,
          responseStatus,
          responseCreated,
        });
        res.end(JSON.stringify({
          id: responseId,
          object: 'refund',
          status: responseStatus,
          amount: Number(refundParams.get('amount')),
          currency: 'usd',
          payment_intent: refundParams.get('payment_intent'),
          created: responseCreated,
          metadata: {
            refund_operation_id: refundParams.get('metadata[refund_operation_id]'),
            refund_attempt_no: refundParams.get('metadata[refund_attempt_no]'),
          },
        }));
      } else if (req.method === 'POST' && req.url === '/test/delay-next-checkout') {
        if (waitingCheckout) {
          res.statusCode = 409;
          res.end(JSON.stringify({ error: { message: 'mock: a Checkout response is already waiting' } }));
          return;
        }
        delayNextCheckout = true;
        res.end(JSON.stringify({ ok: true }));
      } else if (req.method === 'POST' && req.url === '/test/release-checkout') {
        delayNextCheckout = false;
        res.end(JSON.stringify({ ok: true, released: releaseWaitingCheckout() }));
      } else if (req.method === 'POST' && req.url === '/test/delay-next-expire') {
        if (waitingExpire) {
          res.statusCode = 409;
          res.end(JSON.stringify({ error: { message: 'mock: a Checkout expiration response is already waiting' } }));
          return;
        }
        delayNextExpire = true;
        res.end(JSON.stringify({ ok: true }));
      } else if (req.method === 'POST' && req.url === '/test/release-expire') {
        delayNextExpire = false;
        res.end(JSON.stringify({ ok: true, released: releaseWaitingExpire() }));
      } else if (req.method === 'POST' && /^\/test\/refund-status\/(pending|succeeded|requires_action|failed|canceled|unknown)$/.test(req.url ?? '')) {
        nextRefundStatus = String(req.url).split('/').at(-1) as RefundControlStatus;
        res.end(JSON.stringify({ ok: true, nextRefundStatus }));
      } else if (req.method === 'GET' && req.url === '/last-session') {
        res.end(JSON.stringify({ ...lastSessionParams, _idempotencyKey: lastSessionIdempotencyKey }));
      } else if (req.method === 'GET' && /^\/test\/session\/cs_[A-Za-z0-9_]+$/.test(req.url ?? '')) {
        const sessionId = String(req.url).split('/').at(-1)!;
        const session = sessionsById.get(sessionId);
        if (!session) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: { message: 'mock: session not found' } }));
          return;
        }
        res.end(JSON.stringify(session.eventObject));
      } else if (req.method === 'GET' && req.url === '/test-state') {
        res.end(JSON.stringify({
          sessionCount: sessionCounter,
          checkoutWaiting: waitingCheckout !== null,
          expireWaiting: waitingExpire !== null,
          expiredSessions,
          nextRefundStatus,
          refundRequests,
        }));
      } else if (req.method === 'POST' && req.url === '/test/d1') {
        try {
          execFileSync(
            'npx',
            ['wrangler', 'd1', 'execute', 'autoclarity_ppi', '--config', 'wrangler.local.toml', '--local', '--command', body],
            { stdio: 'pipe', timeout: 10_000 },
          );
          res.end(JSON.stringify({ ok: true }));
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(error) }));
        }
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
    ADMIN_NOTIFY_EMAIL: 'owner@example.com',
    // Keep delivery deterministic even if a developer has local provider
    // secrets: these tests assert the provider-neutral recorded state.
    RESEND_API_KEY: '',
  };
  // Pages dev intentionally rejects a custom --config path. Bind the same
  // local resources explicitly while the D1 migration command above continues
  // to use the non-deployable local config. Serve only the small integration
  // fixture directory so the dev server does not watch source, tests,
  // node_modules, and local D1 files as if they were deployable static assets.
  const args = [
    'wrangler', 'pages', 'dev', 'tests/integration/public', '--port', '8799',
    '--compatibility-date', '2026-07-01',
    '--d1', 'DB=00000000-0000-0000-0000-000000000000',
    '--r2', 'UPLOADS=autoclarity-ppi-uploads',
  ];
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
    delayNextCheckout = false;
    releaseWaitingCheckout();
    delayNextExpire = false;
    releaseWaitingExpire();
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
