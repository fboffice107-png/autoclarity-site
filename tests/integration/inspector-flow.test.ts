// Inspector Report Workspace — end-to-end HTTP integration against the real
// local stack (wrangler pages dev + local D1 + local R2). Covers: one report
// per booking, autosave + optimistic concurrency, draft invisibility,
// authorization + cross-customer isolation, photo upload/authorization,
// explicit confirmed publishing, immutable versions, PDF delivery, the
// amendment workflow, audit trail, and idempotent notifications.
import { beforeAll, describe, expect, it } from 'vitest';

const BASE = 'http://127.0.0.1:8799';
const ADMIN_KEY = 'test-admin-key-0123456789abcdef';
const admin = { authorization: `Bearer ${ADMIN_KEY}` };

type Json = Record<string, any>;

async function post(path: string, body: Json, headers: Record<string, string> = {}): Promise<{ status: number; body: Json }> {
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Json };
}
async function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Json }> {
  const res = await fetch(BASE + path, { headers });
  return { status: res.status, body: (await res.json()) as Json };
}

function tinyJpeg(width = 640, height = 480): Uint8Array {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x03, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...sof, 0xff, 0xd9]);
}

let paidokId = '';
let paidokRef = '';
let camryId = '';
let reportId = '';
let seq = 0;
let paidokToken = '';
let camryToken = '';
let photoId = '';

async function customerToken(requestId: string): Promise<string> {
  const r = await post(`/api/admin/requests/${requestId}`, { action: 'reissue_link' }, admin);
  expect(r.status).toBe(200);
  return String(r.body.url).split('t=')[1]!;
}

async function fillEverything(baseSeq: number): Promise<number> {
  // Resolve every checklist item through the real save API in template order.
  const detail = await get(`/api/inspector/reports/${paidokId}`, admin);
  const sections: Json[] = detail.body.template.sections;
  let s = baseSeq;
  for (const sec of sections) {
    const items = sec.items.map((d: Json) => ({ itemKey: d.key, result: 'pass' }));
    const r = await post(`/api/inspector/reports/${paidokId}/save`, { baseSeq: s, items }, admin);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    s = r.body.seq;
  }
  const overall = await post(
    `/api/inspector/reports/${paidokId}/save`,
    {
      baseSeq: s,
      report: {
        score: 7.5,
        verdict: 'negotiate_repair_first',
        executiveSummary: 'Integration-test executive summary long enough to satisfy the readiness gate.',
        odometerMiles: 61250,
        inspectedAt: new Date().toISOString(),
        vinCheck: 'matches',
      },
      items: [
        { itemKey: 'tires_wheels.tread_rl', result: 'attention', customerNote: 'Rear tires at 3/32 — replace soon.', measurementValue: '3', costLowCents: 50000, costHighCents: 90000, priority: 'soon', negotiationItem: true },
        { itemKey: 'safety_restraints.seat_belts', result: 'fail', customerNote: 'Driver belt webbing frayed — replace before regular use.', costLowCents: 15000, costHighCents: 35000, priority: 'immediate', safetyCritical: true },
      ],
    },
    admin,
  );
  expect(overall.status).toBe(200);
  return overall.body.seq;
}

beforeAll(async () => {
  // Fresh fixtures (PAIDOK = confirmed booking; CAMRY = unrelated customer).
  const seeded = await post('/api/admin/seed', {}, admin);
  expect(seeded.status).toBe(200);
  const list = await get('/api/admin/requests?limit=100', admin);
  paidokId = list.body.requests.find((r: Json) => r.ref === 'PPI-FIXTURE-PAIDOK').id;
  paidokRef = 'PPI-FIXTURE-PAIDOK';
  camryId = list.body.requests.find((r: Json) => r.ref === 'PPI-FIXTURE-CAMRY').id;
  paidokToken = await customerToken(paidokId);
  camryToken = await customerToken(camryId);
}, 60_000);

describe('authorization', () => {
  it('rejects every inspector endpoint without the admin credential', async () => {
    for (const [method, path] of [
      ['GET', '/api/inspector/overview'],
      ['POST', '/api/inspector/inspections'],
      ['GET', `/api/inspector/reports/${paidokId}`],
      ['POST', `/api/inspector/reports/${paidokId}/save`],
      ['POST', `/api/inspector/reports/${paidokId}/publish`],
    ] as const) {
      const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      expect(res.status, path).toBe(401);
    }
  });
});

describe('start inspection (one report per booking)', () => {
  it('shows the confirmed booking in the inspector queue', async () => {
    const r = await get('/api/inspector/overview', admin);
    expect(r.status).toBe(200);
    expect(r.body.ready.some((q: Json) => q.request_id === paidokId)).toBe(true);
  });

  it('refuses to start for a non-confirmed request', async () => {
    const r = await post('/api/inspector/inspections', { requestId: camryId }, admin);
    expect(r.status).toBe(409);
  });

  it('creates the report draft and moves the request to inspection_in_progress', async () => {
    const r = await post('/api/inspector/inspections', { requestId: paidokId }, admin);
    expect(r.status).toBe(200);
    expect(r.body.existing).toBe(false);
    reportId = r.body.reportId;
    const detail = await get(`/api/admin/requests/${paidokId}`, admin);
    expect(detail.body.request.status).toBe('inspection_in_progress');
  });

  it('returns the SAME report on a duplicate start (no second report)', async () => {
    const r = await post('/api/inspector/inspections', { requestId: paidokId }, admin);
    expect(r.status).toBe(200);
    expect(r.body.existing).toBe(true);
    expect(r.body.reportId).toBe(reportId);
  });
});

describe('autosave', () => {
  it('saves a batch and advances the sequence', async () => {
    const r = await post(`/api/inspector/reports/${paidokId}/save`, {
      baseSeq: 0,
      report: { odometerMiles: 61250 },
      items: [{ itemKey: 'brakes.front_pads', result: 'pass', measurementValue: '7' }],
    }, admin);
    expect(r.status).toBe(200);
    seq = r.body.seq;
    expect(seq).toBe(1);
  });

  it('resumes after "refresh": a fresh GET returns the saved draft', async () => {
    const r = await get(`/api/inspector/reports/${paidokId}`, admin);
    expect(r.body.report.odometer_miles).toBe(61250);
    const pads = r.body.items.find((i: Json) => i.item_key === 'brakes.front_pads');
    expect(pads.result).toBe('pass');
    expect(pads.measurement_value).toBe('7');
    expect(r.body.report.autosave_seq).toBe(seq);
  });

  it('rejects a stale baseSeq with 409 (another-device conflict)', async () => {
    const r = await post(`/api/inspector/reports/${paidokId}/save`, { baseSeq: 0, report: { odometerMiles: 1 } }, admin);
    expect(r.status).toBe(409);
    const check = await get(`/api/inspector/reports/${paidokId}`, admin);
    expect(check.body.report.odometer_miles).toBe(61250); // not clobbered
    seq = check.body.report.autosave_seq;
  });

  it('validates item keys, results and inverted cost ranges', async () => {
    for (const bad of [
      { items: [{ itemKey: 'nope.nope', result: 'pass' }] },
      { items: [{ itemKey: 'brakes.front_pads', result: 'excellent' }] },
      { items: [{ itemKey: 'brakes.front_pads', result: 'attention', costLowCents: 900, costHighCents: 100 }] },
      { report: { score: 12 } },
    ]) {
      const fresh = (await get(`/api/inspector/reports/${paidokId}`, admin)).body.report.autosave_seq;
      const r = await post(`/api/inspector/reports/${paidokId}/save`, { baseSeq: fresh, ...bad }, admin);
      expect(r.status, JSON.stringify(bad)).toBe(422);
    }
    seq = (await get(`/api/inspector/reports/${paidokId}`, admin)).body.report.autosave_seq;
  });
});

describe('draft invisibility', () => {
  it('the customer portal shows NO report while drafting', async () => {
    const view = await get('/api/portal', { authorization: `Bearer ${paidokToken}` });
    expect(view.status).toBe(200);
    expect(view.body.report).toBeNull();
    const rep = await get('/api/portal/report', { authorization: `Bearer ${paidokToken}` });
    expect(rep.status).toBe(404);
    const pdf = await fetch(`${BASE}/api/portal/report-pdf?t=${paidokToken}`);
    expect(pdf.status).toBe(404);
  });
});

describe('photos (R2 enabled in the test stack)', () => {
  it('uploads a JPEG tied to a finding', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([tinyJpeg()], { type: 'image/jpeg' }), 'tread.jpg');
    fd.append('itemKey', 'tires_wheels.tread_rl');
    fd.append('caption', 'Rear-left tread');
    const res = await fetch(`${BASE}/api/inspector/reports/${paidokId}/photos`, { method: 'POST', headers: admin, body: fd });
    const body = (await res.json()) as Json;
    expect(res.status).toBe(200);
    photoId = body.id;
    expect(body.width).toBe(640);
  });

  it('rejects a non-image upload', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([new TextEncoder().encode('#!/bin/sh evil')], { type: 'image/jpeg' }), 'evil.jpg');
    const res = await fetch(`${BASE}/api/inspector/reports/${paidokId}/photos`, { method: 'POST', headers: admin, body: fd });
    expect(res.status).toBe(422);
  });

  it('rejects a photo against an unknown checklist item', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([tinyJpeg()], { type: 'image/jpeg' }), 'x.jpg');
    fd.append('itemKey', 'not.an.item');
    const res = await fetch(`${BASE}/api/inspector/reports/${paidokId}/photos`, { method: 'POST', headers: admin, body: fd });
    expect(res.status).toBe(422);
  });

  it('keeps unpublished photos invisible to the customer', async () => {
    const res = await fetch(`${BASE}/api/portal/report-photo?id=${photoId}&t=${paidokToken}`);
    expect(res.status).toBe(404);
  });
});

describe('publish workflow', () => {
  it('blocks publishing before the checklist is complete', async () => {
    const state = await post(`/api/inspector/reports/${paidokId}/state`, { to: 'draft_complete' }, admin);
    expect(state.status).toBe(200);
    const ready = await post(`/api/inspector/reports/${paidokId}/state`, { to: 'ready_for_review' }, admin);
    expect(ready.status).toBe(200);
    const r = await post(`/api/inspector/reports/${paidokId}/publish`, { confirm: paidokRef }, admin);
    expect(r.status).toBe(409);
    expect(r.body.error.problems.length).toBeGreaterThan(0);
    // reopen to finish the checklist
    const reopen = await post(`/api/inspector/reports/${paidokId}/state`, { to: 'in_progress' }, admin);
    expect(reopen.status).toBe(200);
  });

  it('completes the checklist through the save API', async () => {
    seq = (await get(`/api/inspector/reports/${paidokId}`, admin)).body.report.autosave_seq;
    seq = await fillEverything(seq);
    const r = await get(`/api/inspector/reports/${paidokId}/preview`, admin);
    expect(r.body.readiness.ok).toBe(true);
  });

  it('requires ready_for_review AND the typed confirmation phrase', async () => {
    const early = await post(`/api/inspector/reports/${paidokId}/publish`, { confirm: paidokRef }, admin);
    expect(early.status).toBe(409); // still in_progress
    await post(`/api/inspector/reports/${paidokId}/state`, { to: 'draft_complete' }, admin);
    await post(`/api/inspector/reports/${paidokId}/state`, { to: 'ready_for_review' }, admin);
    const wrong = await post(`/api/inspector/reports/${paidokId}/publish`, { confirm: 'NOPE' }, admin);
    expect(wrong.status).toBe(422);
  });

  it('publishes version 1 and locks the draft', async () => {
    const r = await post(`/api/inspector/reports/${paidokId}/publish`, { confirm: paidokRef }, admin);
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(1);
    expect(r.body.pdfStored).toBe(true);
    const locked = await post(`/api/inspector/reports/${paidokId}/save`, { baseSeq: seq, report: { score: 10 } }, admin);
    expect(locked.status).toBe(423);
  });

  it('moves the request to completed and records the audit + notification exactly once', async () => {
    const detail = await get(`/api/admin/requests/${paidokId}`, admin);
    expect(detail.body.request.status).toBe('completed');
    const msgs = detail.body.messages.filter((m: Json) => m.template === 'report_ready');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].dedupe_key).toContain('report_ready:');
  });
});

describe('customer delivery', () => {
  it('shows the published report in the portal view and serves the payload', async () => {
    paidokToken = await customerToken(paidokId); // publish rotated the link
    const view = await get('/api/portal', { authorization: `Bearer ${paidokToken}` });
    expect(view.body.report.version).toBe(1);
    const rep = await get('/api/portal/report', { authorization: `Bearer ${paidokToken}` });
    expect(rep.status).toBe(200);
    expect(rep.body.payload.overall.score).toBe(7.5);
    expect(rep.body.payload.ref).toBe(paidokRef);
    // internal notes never appear on the customer path
    expect(JSON.stringify(rep.body)).not.toContain('inspector_notes');
  });

  it('serves the branded PDF with the same data', async () => {
    const res = await fetch(`${BASE}/api/portal/report-pdf?t=${paidokToken}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/pdf');
    const text = new TextDecoder('latin1').decode(await res.arrayBuffer());
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain(paidokRef);
    expect(text).toContain('Negotiate / Repair First');
  });

  it('serves published photos to the owning customer only', async () => {
    const mine = await fetch(`${BASE}/api/portal/report-photo?id=${photoId}&t=${paidokToken}`);
    expect(mine.status).toBe(200);
    const theirs = await fetch(`${BASE}/api/portal/report-photo?id=${photoId}&t=${camryToken}`);
    expect(theirs.status).toBe(404);
  });

  it('keeps another customer fully isolated from this report', async () => {
    const rep = await get('/api/portal/report', { authorization: `Bearer ${camryToken}` });
    expect(rep.status).toBe(404);
    const pdf = await fetch(`${BASE}/api/portal/report-pdf?t=${camryToken}`);
    expect(pdf.status).toBe(404);
  });
});

describe('amendment workflow + immutable versions', () => {
  let v1Sha = '';

  it('reopens the draft with a reason; the customer keeps seeing v1', async () => {
    const versions = (await get(`/api/inspector/reports/${paidokId}`, admin)).body.versions;
    v1Sha = versions[0].payload_sha256;
    const r = await post(`/api/inspector/reports/${paidokId}/amend`, { reason: 'Corrected a measurement' }, admin);
    expect(r.status).toBe(200);
    // edit during the amendment
    const cur = (await get(`/api/inspector/reports/${paidokId}`, admin)).body.report.autosave_seq;
    const save = await post(`/api/inspector/reports/${paidokId}/save`, {
      baseSeq: cur,
      report: { score: 7 },
      items: [{ itemKey: 'tires_wheels.tread_rl', result: 'attention', customerNote: 'Re-measured at 4/32.', measurementValue: '4', priority: 'soon' }],
    }, admin);
    expect(save.status).toBe(200);
    const rep = await get('/api/portal/report', { authorization: `Bearer ${paidokToken}` });
    expect(rep.status).toBe(200);
    expect(rep.body.version).toBe(1);
    expect(rep.body.payload.overall.score).toBe(7.5); // still v1
  });

  it('requires an amendment reason at publish and creates version 2', async () => {
    await post(`/api/inspector/reports/${paidokId}/state`, { to: 'draft_complete' }, admin);
    await post(`/api/inspector/reports/${paidokId}/state`, { to: 'ready_for_review' }, admin);
    const noReason = await post(`/api/inspector/reports/${paidokId}/publish`, { confirm: paidokRef }, admin);
    expect(noReason.status).toBe(422);
    const r = await post(`/api/inspector/reports/${paidokId}/publish`, { confirm: paidokRef, amendmentReason: 'Corrected a measurement' }, admin);
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(2);
  });

  it('customer sees v2; version history shows v1 superseded with v1 payload unchanged', async () => {
    paidokToken = await customerToken(paidokId);
    const rep = await get('/api/portal/report', { authorization: `Bearer ${paidokToken}` });
    expect(rep.body.version).toBe(2);
    expect(rep.body.kind).toBe('amendment');
    expect(rep.body.payload.overall.score).toBe(7);
    expect(rep.body.history.map((h: Json) => [h.version, h.status])).toEqual([[2, 'published'], [1, 'superseded']]);

    const versions = (await get(`/api/inspector/reports/${paidokId}`, admin)).body.versions;
    const v1 = versions.find((v: Json) => v.version === 1);
    expect(v1.status).toBe('superseded');
    expect(v1.payload_sha256).toBe(v1Sha); // immutable snapshot
    const v2 = versions.find((v: Json) => v.version === 2);
    expect(v2.kind).toBe('amendment');
    expect(v2.amendment_reason).toBe('Corrected a measurement');
  });

  it('sends the amended-report notification exactly once', async () => {
    const detail = await get(`/api/admin/requests/${paidokId}`, admin);
    const amended = detail.body.messages.filter((m: Json) => m.template === 'report_amended');
    expect(amended).toHaveLength(1);
  });
});

describe('private-surface hygiene', () => {
  it('inspector pages and APIs are noindex; robots disallows /inspector/', async () => {
    const page = await fetch(`${BASE}/inspector/`);
    expect(page.headers.get('x-robots-tag')).toContain('noindex');
    const api = await fetch(`${BASE}/api/inspector/overview`);
    expect(api.headers.get('x-robots-tag')).toContain('noindex');
    const robots = await (await fetch(`${BASE}/robots.txt`)).text();
    expect(robots).toContain('Disallow: /inspector/');
  });

  it('serves the editor shell at the clean dynamic route', async () => {
    const res = await fetch(`${BASE}/inspector/inspections/${paidokId}/report`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('inspector-report.js');
  });
});
