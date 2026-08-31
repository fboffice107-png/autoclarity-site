import { describe, expect, it, vi } from 'vitest';
import { onRequest } from '../../functions/_middleware.ts';

const runMiddleware = onRequest[0]!;

function context(url: string, method = 'GET', env: Record<string, unknown> = { PPI_ENV: 'production' }) {
  return {
    request: new Request(url, { method }),
    env,
    params: {},
    data: {},
    functionPath: '',
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    next: vi.fn(async () => new Response('ok')),
  } as any;
}

describe('global Pages middleware', () => {
  it('redirects safe www page requests to the canonical apex host', async () => {
    const response = await runMiddleware(context('https://www.getautoclarity.com/las-vegas-pre-purchase-inspection/?utm_source=test'));

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe(
      'https://getautoclarity.com/las-vegas-pre-purchase-inspection/?utm_source=test',
    );
  });

  it('does not redirect API submissions across origins', async () => {
    const ctx = context('https://www.getautoclarity.com/api/ppi/requests', 'POST');
    const response = await runMiddleware(ctx);

    expect(response.status).toBe(200);
    expect(ctx.next).toHaveBeenCalledOnce();
  });

  it('does not canonicalize hosted previews', async () => {
    const ctx = context('https://preview.autoclarity-site.pages.dev/', 'GET', { PPI_ENV: 'preview' });
    const response = await runMiddleware(ctx);

    expect(response.status).toBe(200);
    expect(ctx.next).toHaveBeenCalledOnce();
  });

  it.each([
    '/.git/config',
    '/.github/workflows/deploy.yml',
    '/.claude/launch.json',
    '/.codex/settings.json',
    '/.wrangler/state/db.sqlite',
    '/coverage/index.html',
  ])('blocks hidden tooling and generated paths before static asset serving: %s', async (pathname) => {
    const ctx = context(`https://getautoclarity.com${pathname}`);
    const response = await runMiddleware(ctx);

    expect(response.status).toBe(404);
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(ctx.next).not.toHaveBeenCalled();
  });
});
