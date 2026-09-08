import { beforeAll, describe, expect, it } from 'vitest';

const BASE = 'http://127.0.0.1:8799';
const ADMIN_KEY = 'test-admin-key-0123456789abcdef';
const admin = { authorization: `Bearer ${ADMIN_KEY}` };

type Json = Record<string, any>;

async function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Json }> {
  const response = await fetch(BASE + path, { headers });
  return { status: response.status, body: await response.json() as Json };
}

async function post(
  body: unknown,
  headers: Record<string, string> = admin,
): Promise<{ status: number; body: Json }> {
  const response = await fetch(BASE + '/api/admin/lead-review', {
    method: 'POST',
    headers: { origin: BASE, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Json };
}

let submittedId = '';
let paidId = '';

beforeAll(async () => {
  const seeded = await fetch(BASE + '/api/admin/seed', {
    method: 'POST',
    headers: { ...admin, origin: BASE, 'content-type': 'application/json' },
    body: '{}',
  });
  expect(seeded.status).toBe(200);
  const queue = await get('/api/admin/lead-review?classification=all&limit=100', admin);
  expect(queue.status).toBe(200);
  submittedId = queue.body.queue.find((row: Json) => row.ref === 'PPI-FIXTURE-CAMRY')?.id ?? '';
  paidId = queue.body.queue.find((row: Json) => row.ref === 'PPI-FIXTURE-PAIDOK')?.id ?? '';
  expect(submittedId).toBeTruthy();
  expect(paidId).toBeTruthy();
});

describe('protected lead classification HTTP workflow', () => {
  it('requires admin authentication and a safe mutation origin', async () => {
    expect((await get('/api/admin/lead-review')).status).toBe(401);

    const missingOrigin = await fetch(BASE + '/api/admin/lead-review', {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: submittedId,
        expectedClassification: 'needs_owner_review',
        classification: 'genuine',
      }),
    });
    expect(missingOrigin.status).toBe(403);

    expect((await post({
      requestId: submittedId,
      expectedClassification: 'needs_owner_review',
      classification: 'genuine',
    }, { ...admin, origin: 'https://evil.example' })).status).toBe(403);
  });

  it('returns only the bounded review fields and combines filters independently', async () => {
    const queue = await get('/api/admin/lead-review?classification=needs_owner_review&status=submitted&limit=1', admin);
    expect(queue.status).toBe(200);
    expect(queue.body.filters).toEqual({
      classification: 'needs_owner_review', status: 'submitted', limit: 1,
    });
    expect(queue.body.queue).toHaveLength(1);
    expect(Object.keys(queue.body.queue[0]).sort()).toEqual([
      'ageDays', 'attributionSource', 'classification', 'createdDate', 'hasBooking',
      'hasCompletion', 'hasPayment', 'hasReconciliationEvidence', 'id', 'location',
      'ref', 'status', 'vehicle',
    ]);
    const serialized = JSON.stringify(queue.body);
    for (const privateValue of [
      'fixture+camry@example.com', 'Test Customer (Fixture)', '7025550100',
      '4T1B11HK5KU212345', 'Standard 2019 Toyota Camry request',
    ]) expect(serialized).not.toContain(privateValue);
  });

  it('applies exact labels with CAS while preserving service state', async () => {
    const before = await get(`/api/admin/requests/${encodeURIComponent(submittedId)}`, admin);
    expect(before.status).toBe(200);
    const protectedBefore = {
      status: before.body.request.status,
      createdAt: before.body.request.created_at,
      updatedAt: before.body.request.updated_at,
      history: before.body.history,
      messages: before.body.messages,
      quotes: before.body.quotes,
      payments: before.body.payments,
      acceptances: before.body.acceptances,
    };

    const changed = await post({
      requestId: submittedId,
      expectedClassification: 'needs_owner_review',
      classification: 'genuine',
    });
    expect(changed).toEqual({ status: 200, body: { ok: true, noChange: false, classification: 'genuine' } });

    const stale = await post({
      requestId: submittedId,
      expectedClassification: 'needs_owner_review',
      classification: 'spam',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'conflict', currentClassification: 'genuine' });

    const noChange = await post({
      requestId: submittedId,
      expectedClassification: 'genuine',
      classification: 'genuine',
    });
    expect(noChange.body).toMatchObject({ ok: true, noChange: true });

    const corrected = await post({
      requestId: submittedId,
      expectedClassification: 'genuine',
      classification: 'closed',
    });
    expect(corrected.status).toBe(200);

    const after = await get(`/api/admin/requests/${encodeURIComponent(submittedId)}`, admin);
    expect(after.body.request.lead_classification).toBe('closed');
    expect({
      status: after.body.request.status,
      createdAt: after.body.request.created_at,
      updatedAt: after.body.request.updated_at,
      history: after.body.history,
      messages: after.body.messages,
      quotes: after.body.quotes,
      payments: after.body.payments,
      acceptances: after.body.acceptances,
    }).toEqual(protectedBefore);

    expect((await post({
      requestId: submittedId,
      expectedClassification: 'closed',
      classification: 'Genuine',
    })).status).toBe(422);
  });

  it('keeps financially evidenced excluded labels visible as reconciliation warnings', async () => {
    const paid = await get(`/api/admin/requests/${encodeURIComponent(paidId)}`, admin);
    const expected = paid.body.request.lead_classification;
    expect((await post({
      requestId: paidId,
      expectedClassification: expected,
      classification: 'test',
    })).status).toBe(200);

    const all = await get('/api/admin/lead-review?classification=all&limit=100', admin);
    const row = all.body.queue.find((item: Json) => item.id === paidId);
    expect(row).toMatchObject({
      classification: 'test', hasPayment: true, hasBooking: true, hasReconciliationEvidence: true,
    });
    expect(all.body.reconciliationWarningCount).toBeGreaterThanOrEqual(1);
  });
});
