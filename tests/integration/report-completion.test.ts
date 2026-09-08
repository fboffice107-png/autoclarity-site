import { describe, expect, it } from 'vitest';

const BASE = 'http://127.0.0.1:8799';
const ADMIN_KEY = 'test-admin-key-0123456789abcdef';
const adminHeaders = { authorization: `Bearer ${ADMIN_KEY}` };

type Json = Record<string, any>;

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function executeLocalD1(sql: string): Promise<void> {
  const response = await fetch('http://127.0.0.1:8798/test/d1', { method: 'POST', body: sql });
  if (!response.ok) throw new Error(`Local D1 test injection failed: ${await response.text()}`);
}

async function adminPost(id: string, body: Json): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${BASE}/api/admin/requests/${id}`, {
    method: 'POST',
    headers: { ...adminHeaders, 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Json };
}

async function adminGet(id: string): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${BASE}/api/admin/requests/${id}`, { headers: adminHeaders });
  return { status: response.status, body: await response.json() as Json };
}

async function portalGet(token: string): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${BASE}/api/portal`, {
    headers: {
      authorization: `Bearer ${token}`,
      // Isolate this scenario from the shared-suite portal rate-limit bucket.
      'cf-connecting-ip': '198.51.100.42',
    },
  });
  return { status: response.status, body: await response.json() as Json };
}

describe('report-backed completion', () => {
  it('guards completion, exposes only the selected request snapshot, and records one stable report-ready email', async () => {
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
    const requestA = `req_report_http_a_${suffix}`;
    const requestB = `req_report_http_b_${suffix}`;
    const customerA = `cus_report_http_a_${suffix}`;
    const customerB = `cus_report_http_b_${suffix}`;
    const vehicleA = `veh_report_http_a_${suffix}`;
    const vehicleB = `veh_report_http_b_${suffix}`;
    const reportA = `rpt_report_http_a_${suffix}`;
    const reportB = `rpt_report_http_b_${suffix}`;
    const selectedVersionA = `rv_report_http_a_1_${suffix}`;
    const looseVersionA = `rv_report_http_a_2_${suffix}`;
    const selectedVersionB = `rv_report_http_b_1_${suffix}`;
    const now = new Date().toISOString();

    await executeLocalD1(`
      INSERT INTO customers (id, full_name, email, phone, created_at, updated_at) VALUES
        (${sqlLiteral(customerA)}, 'HTTP Report Customer A', 'http-report-a@example.com', '702-555-0151', ${sqlLiteral(now)}, ${sqlLiteral(now)}),
        (${sqlLiteral(customerB)}, 'HTTP Report Customer B', 'http-report-b@example.com', '702-555-0152', ${sqlLiteral(now)}, ${sqlLiteral(now)});
      INSERT INTO vehicles (id, year, make, model, created_at, updated_at) VALUES
        (${sqlLiteral(vehicleA)}, 2020, 'Test', 'Report A', ${sqlLiteral(now)}, ${sqlLiteral(now)}),
        (${sqlLiteral(vehicleB)}, 2021, 'Test', 'Report B', ${sqlLiteral(now)}, ${sqlLiteral(now)});
      INSERT INTO ppi_requests
        (id, ref, customer_id, vehicle_id, status, loc_city, loc_state, attribution_source, created_at, updated_at) VALUES
        (${sqlLiteral(requestA)}, ${sqlLiteral(`PPI-HTTP-REPORT-A-${suffix}`)}, ${sqlLiteral(customerA)}, ${sqlLiteral(vehicleA)}, 'inspection_in_progress', 'Las Vegas', 'NV', 'ppi_direct', ${sqlLiteral(now)}, ${sqlLiteral(now)}),
        (${sqlLiteral(requestB)}, ${sqlLiteral(`PPI-HTTP-REPORT-B-${suffix}`)}, ${sqlLiteral(customerB)}, ${sqlLiteral(vehicleB)}, 'report_in_progress', 'Henderson', 'NV', 'ppi_direct', ${sqlLiteral(now)}, ${sqlLiteral(now)});
    `);

    const skipped = await adminPost(requestA, { action: 'set_status', to: 'completed' });
    expect(skipped.status).toBe(409);
    expect(skipped.body.error.code).toBe('invalid_transition');

    const reportStage = await adminPost(requestA, { action: 'set_status', to: 'report_in_progress' });
    expect(reportStage.status).toBe(200);

    const missingReport = await adminPost(requestA, { action: 'set_status', to: 'completed' });
    expect(missingReport.status).toBe(409);
    expect(missingReport.body.error.code).toBe('report_required');

    const linkA = await adminPost(requestA, { action: 'reissue_link' });
    const linkB = await adminPost(requestB, { action: 'reissue_link' });
    expect(linkA.status).toBe(200);
    expect(linkB.status).toBe(200);
    const tokenA = new URL(linkA.body.url).searchParams.get('t') ?? '';
    const tokenB = new URL(linkB.body.url).searchParams.get('t') ?? '';
    expect(tokenA.length).toBeGreaterThan(30);
    expect(tokenB.length).toBeGreaterThan(30);

    const payloadA = {
      schema: 'autoclarity.ppi.report',
      schemaVersion: 1,
      inspector: 'HTTP Test Inspector',
      overall: { score: 8.7, verdict: 'proceed', verdictLabel: 'Proceed', executiveSummary: 'Selected report A' },
      sections: [],
    };
    const loosePayloadA = {
      schema: 'autoclarity.ppi.report',
      schemaVersion: 1,
      overall: { executiveSummary: 'Loose newer report A must stay hidden' },
      sections: [],
    };
    const payloadB = {
      schema: 'autoclarity.ppi.report',
      schemaVersion: 1,
      overall: { executiveSummary: 'Private report B' },
      sections: [],
    };
    const jsonA = JSON.stringify(payloadA);
    const looseJsonA = JSON.stringify(loosePayloadA);
    const jsonB = JSON.stringify(payloadB);

    await executeLocalD1(`
      INSERT INTO inspection_reports
        (id, request_id, customer_id, vehicle_id, state, started_by, published_version_id, published_at, created_at, updated_at) VALUES
        (${sqlLiteral(reportA)}, ${sqlLiteral(requestA)}, ${sqlLiteral(customerA)}, ${sqlLiteral(vehicleA)}, 'published', 'test:inspector', ${sqlLiteral(selectedVersionA)}, ${sqlLiteral(now)}, ${sqlLiteral(now)}, ${sqlLiteral(now)}),
        (${sqlLiteral(reportB)}, ${sqlLiteral(requestB)}, ${sqlLiteral(customerB)}, ${sqlLiteral(vehicleB)}, 'published', 'test:inspector', ${sqlLiteral(selectedVersionB)}, ${sqlLiteral(now)}, ${sqlLiteral(now)}, ${sqlLiteral(now)});
      INSERT INTO report_versions
        (id, report_id, request_id, version, status, kind, payload_json, payload_sha256, published_by, published_at) VALUES
        (${sqlLiteral(selectedVersionA)}, ${sqlLiteral(reportA)}, ${sqlLiteral(requestA)}, 1, 'published', 'original', ${sqlLiteral(jsonA)}, ${sqlLiteral(await sha256Hex(jsonA))}, 'test:inspector', ${sqlLiteral(now)}),
        (${sqlLiteral(looseVersionA)}, ${sqlLiteral(reportA)}, ${sqlLiteral(requestA)}, 2, 'published', 'amendment', ${sqlLiteral(looseJsonA)}, ${sqlLiteral(await sha256Hex(looseJsonA))}, 'test:inspector', ${sqlLiteral(now)}),
        (${sqlLiteral(selectedVersionB)}, ${sqlLiteral(reportB)}, ${sqlLiteral(requestB)}, 1, 'published', 'original', ${sqlLiteral(jsonB)}, ${sqlLiteral(await sha256Hex(jsonB))}, 'test:inspector', ${sqlLiteral(now)});
    `);

    const [firstAttempt, racingAttempt] = await Promise.all([
      adminPost(requestA, { action: 'set_status', to: 'completed' }),
      adminPost(requestA, { action: 'set_status', to: 'completed' }),
    ]);
    const outcomes = [firstAttempt, racingAttempt];
    expect(outcomes.filter((outcome) => outcome.status === 200)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 409)).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === 409)?.body.error.code).toMatch(/^(conflict|invalid_transition)$/);
    const success = outcomes.find((outcome) => outcome.status === 200)!;
    expect(success.body.notification.emailStatus).toBe('recorded');

    const portalA = await portalGet(tokenA);
    expect(portalA.status).toBe(200);
    expect(portalA.body.report).toMatchObject({
      reportId: reportA,
      versionId: selectedVersionA,
      version: 1,
      payload: payloadA,
    });
    expect(JSON.stringify(portalA.body.report)).not.toContain('Loose newer report A must stay hidden');
    expect(JSON.stringify(portalA.body.report)).not.toContain('Private report B');

    const portalB = await portalGet(tokenB);
    expect(portalB.status).toBe(200);
    expect(portalB.body.report).toMatchObject({
      reportId: reportB,
      versionId: selectedVersionB,
      payload: payloadB,
    });

    let detail = await adminGet(requestA);
    expect(detail.status).toBe(200);
    expect(detail.body.request.status).toBe('completed');
    const reportReady = detail.body.messages.filter((message: Json) => message.template === 'report_ready');
    expect(reportReady).toHaveLength(1);
    expect(reportReady[0].id).toBe(success.body.notification.messageId);
    expect(reportReady[0].dedupe_key).toBe(`report_ready:${selectedVersionA}`);
    const completedHistory = detail.body.history.filter((entry: Json) => entry.to_status === 'completed');
    expect(completedHistory).toHaveLength(1);
    expect(completedHistory[0].related_id).toBe(selectedVersionA);

    // Simulate an operator/database regression that reopens the same report.
    // A second successful completion still resolves to the original outbox row.
    await executeLocalD1(
      `UPDATE ppi_requests SET status = 'report_in_progress', updated_at = ${sqlLiteral(new Date().toISOString())} WHERE id = ${sqlLiteral(requestA)};`,
    );
    const repeatedCompletion = await adminPost(requestA, { action: 'set_status', to: 'completed' });
    expect(repeatedCompletion.status).toBe(200);
    expect(repeatedCompletion.body.notification.messageId).toBe(reportReady[0].id);

    detail = await adminGet(requestA);
    expect(detail.body.messages.filter((message: Json) => message.template === 'report_ready')).toHaveLength(1);
    expect(detail.body.history.filter((entry: Json) => entry.to_status === 'completed')).toHaveLength(1);
  });
});
