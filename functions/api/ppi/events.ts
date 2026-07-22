// POST /api/ppi/events — first-party funnel analytics. Allowlisted event names
// and step labels only; no PII fields exist in the schema by design.

import type { Env } from '../../lib/types.ts';
import { rateLimit } from '../../lib/ratelimit.ts';
import { clientIp, json, newId, nowIso } from '../../lib/util.ts';

const ALLOWED_EVENTS = new Set([
  'ppi_page_view',
  'ppi_cta_click',
  'ppi_founder_cta_click',
  'ppi_sample_report_view',
  'ppi_call_click',
  'ppi_text_click',
  'ppi_form_started',
  'ppi_form_step_completed',
  'ppi_request_submitted',
  'ppi_quote_sent',
  'ppi_slot_selected',
  'ppi_agreement_accepted',
  'ppi_checkout_started',
  'ppi_payment_confirmed',
  'ppi_booking_confirmed',
  'ppi_cancelled',
  'ppi_completed',
  'ppi_waitlist_joined',
]);

const STEP_RE = /^[a-z0-9_-]{0,40}$/;

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  const limited = await rateLimit(env.DB, clientIp(request), 'events', 120, 3600);
  if (!limited.allowed) return json({ ok: true }); // silently drop; analytics is best-effort

  let body: { event?: string; step?: string; source?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: true });
  }

  const event = String(body.event ?? '');
  const step = String(body.step ?? '');
  const source = String(body.source ?? '');
  if (!ALLOWED_EVENTS.has(event) || !STEP_RE.test(step) || !STEP_RE.test(source)) {
    return json({ ok: true });
  }

  await env.DB
    .prepare(`INSERT INTO analytics_events (id, event, step, source, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(newId('ev'), event, step || null, source || null, nowIso())
    .run();

  return json({ ok: true });
};
