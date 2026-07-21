// GET /api/portal/calendar?t=... — .ics file for a confirmed appointment.

import type { Env } from '../../lib/types.ts';
import { requirePortal } from '../../lib/portal.ts';
import { buildIcs } from '../../lib/ics.ts';
import { errorJson } from '../../lib/util.ts';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = await requirePortal(context.request, context.env);
  if (!auth.ok) return auth.response;

  const row = await context.env.DB
    .prepare(
      `SELECT r.ref, r.loc_street, r.loc_city, r.loc_state, r.loc_zip, s.starts_at, s.ends_at
       FROM bookings b
       JOIN ppi_requests r ON r.id = b.request_id
       JOIN appointment_slots s ON s.id = b.slot_id
       WHERE b.request_id = ? AND b.status = 'confirmed'`,
    )
    .bind(auth.requestId)
    .first<{ ref: string; loc_street: string | null; loc_city: string | null; loc_state: string | null; loc_zip: string | null; starts_at: string; ends_at: string }>();
  if (!row) return errorJson('not_confirmed', 'No confirmed appointment yet.', 404);

  const ics = buildIcs({
    uid: row.ref,
    startsAtIso: row.starts_at,
    endsAtIso: row.ends_at,
    summary: `AutoClarity Pre-Purchase Inspection (${row.ref})`,
    description: 'Mobile pre-purchase inspection by AutoClarity. Questions: support@getautoclarity.com',
    location: [row.loc_street, row.loc_city, row.loc_state, row.loc_zip].filter(Boolean).join(', '),
  });

  return new Response(ics, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `attachment; filename="autoclarity-ppi-${row.ref}.ics"`,
      'cache-control': 'private, no-store',
    },
  });
};
