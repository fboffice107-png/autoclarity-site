// Unit tests: report template integrity, authoring state machine, snapshot
// builder (rollups, draft-note exclusion), and publish readiness rules.
import { describe, expect, it } from 'vitest';
import {
  REPORT_SECTIONS,
  allItemKeys,
  itemDef,
  sectionDef,
  STANDARD_LIMITATIONS,
  VERDICT_LABELS,
} from '../../functions/lib/report-template.ts';
import {
  buildSnapshot,
  canMoveState,
  displayState,
  publishReadiness,
  type ItemRow,
  type ReportRow,
  type RequestContext,
  type SectionRow,
} from '../../functions/lib/report.ts';

function makeReport(overrides: Partial<ReportRow> = {}): ReportRow {
  return {
    id: 'rpt_test',
    request_id: 'req_test',
    booking_id: 'bkg_test',
    customer_id: 'cus_test',
    vehicle_id: 'veh_test',
    quote_id: 'qot_test',
    state: 'in_progress',
    template_key: 'ppi',
    template_version: 1,
    inspected_at: '2026-07-23T17:00:00.000Z',
    odometer_miles: 61250,
    plate: null,
    plate_state: null,
    vin_check: 'matches',
    vin_observed: null,
    title_disclosure_notes: null,
    seller_notes: null,
    score: 7.5,
    verdict: 'negotiate_repair_first',
    executive_summary: 'A representative executive summary that is comfortably longer than forty characters.',
    positive_findings: 'Strong cold start.',
    negotiation_summary: 'Tires are a documented ask.',
    limitations_notes: null,
    autosave_seq: 3,
    started_by: 'admin:test',
    published_version_id: null,
    published_at: null,
    created_at: '2026-07-23T16:00:00.000Z',
    updated_at: '2026-07-23T17:30:00.000Z',
    ...overrides,
  };
}

const CTX: RequestContext = {
  request_id: 'req_test',
  ref: 'PPI-TEST-0001',
  status: 'inspection_in_progress',
  customer_name: 'Test Customer',
  customer_email: 'test@example.com',
  year: 2017,
  make: 'Lexus',
  model: 'RX 350',
  trim: 'F Sport',
  vin: '2T2BZMCA5HC100001',
  mileage: 61000,
  seller_type: 'dealership',
  seller_name: null,
  title_status: 'clean',
  loc_city: 'Las Vegas',
  loc_state: 'NV',
  starts_at: '2026-07-26T16:00:00.000Z',
  ends_at: '2026-07-26T18:00:00.000Z',
};

function itemRow(key: string, overrides: Partial<ItemRow> = {}): ItemRow {
  const def = itemDef(key);
  if (!def) throw new Error(`bad key ${key}`);
  return {
    id: `ri_${key}`,
    report_id: 'rpt_test',
    section_key: def.section.key,
    item_key: key,
    result: 'pass',
    not_inspected_reason: null,
    inspector_notes: null,
    customer_note: null,
    measurement_value: null,
    measurement_unit: null,
    cost_low_cents: null,
    cost_high_cents: null,
    priority: null,
    safety_critical: 0,
    negotiation_item: 0,
    ...overrides,
  };
}

/** Every item marked pass except explicitly overridden ones. */
function fullItems(overrides: Record<string, Partial<ItemRow>> = {}): ItemRow[] {
  return allItemKeys().map((k) => itemRow(k, overrides[k] ?? {}));
}

describe('report template', () => {
  it('has globally unique, section-prefixed item keys', () => {
    const keys = allItemKeys();
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of REPORT_SECTIONS) {
      for (const d of s.items) expect(d.key.startsWith(`${s.key}.`)).toBe(true);
    }
  });

  it('covers the required inspection areas', () => {
    for (const k of [
      'exterior_body', 'collision_repair', 'glass_lamps', 'tires_wheels', 'brakes',
      'steering_suspension', 'engine', 'cooling', 'transmission_drivetrain',
      'battery_charging', 'interior', 'safety_restraints', 'electronics', 'hvac',
      'instruments', 'diagnostic_scan', 'road_test', 'underbody',
    ]) {
      expect(sectionDef(k), k).toBeTruthy();
    }
  });

  it('marks scan, road test and underbody as conditional', () => {
    expect(sectionDef('diagnostic_scan')?.conditional).toBe(true);
    expect(sectionDef('road_test')?.conditional).toBe(true);
    expect(sectionDef('underbody')?.conditional).toBe(true);
  });

  it('never promises a guarantee in the standard limitations', () => {
    expect(STANDARD_LIMITATIONS).toContain('not a warranty or a');
    expect(STANDARD_LIMITATIONS.toLowerCase()).not.toContain('guaranteed safe');
  });
});

describe('authoring state machine', () => {
  it('allows the forward path and reopening', () => {
    expect(canMoveState('in_progress', 'draft_complete')).toBe(true);
    expect(canMoveState('draft_complete', 'ready_for_review')).toBe(true);
    expect(canMoveState('draft_complete', 'in_progress')).toBe(true);
    expect(canMoveState('ready_for_review', 'in_progress')).toBe(true);
  });

  it('never allows publishing through the plain state move', () => {
    expect(canMoveState('in_progress', 'published' as never)).toBe(false);
    expect(canMoveState('ready_for_review', 'published' as never)).toBe(false);
    expect(canMoveState('published', 'in_progress')).toBe(false); // amend endpoint only
  });

  it('labels amended and amending display states', () => {
    expect(displayState('published', 1)).toBe('published');
    expect(displayState('published', 2)).toBe('amended');
    expect(displayState('in_progress', 1)).toContain('amending');
    expect(displayState('in_progress', 0)).toBe('in_progress');
  });
});

describe('publish readiness', () => {
  it('blocks publishing an empty report', () => {
    const r = publishReadiness(makeReport({ score: null, verdict: null, executive_summary: null }), [], []);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toContain('score');
    expect(r.problems.join(' ')).toContain('verdict');
  });

  it('blocks when items are unresolved, passes when complete', () => {
    const partial = publishReadiness(makeReport(), [], [itemRow('brakes.front_pads')]);
    expect(partial.ok).toBe(false);
    const complete = publishReadiness(makeReport(), [], fullItems());
    expect(complete.ok).toBe(true);
  });

  it('accepts a section skipped with a reason in place of its items', () => {
    const sections: SectionRow[] = [
      { section_key: 'diagnostic_scan', performed: 'not_performed', not_performed_reason: 'equipment_unavailable', summary_note: null },
    ];
    const items = fullItems().filter((i) => i.section_key !== 'diagnostic_scan');
    expect(publishReadiness(makeReport(), sections, items).ok).toBe(true);
  });

  it('requires a reason for not-inspected items', () => {
    const items = fullItems({ 'engine.oil_leaks': { result: 'not_inspected', not_inspected_reason: null } });
    const r = publishReadiness(makeReport(), [], items);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toContain('reason');
  });

  it('warns (not blocks) on attention items without customer notes', () => {
    const items = fullItems({ 'brakes.brake_fluid': { result: 'attention' } });
    const r = publishReadiness(makeReport(), [], items);
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toContain('customer-facing');
  });
});

describe('snapshot builder', () => {
  const meta = { version: 1, kind: 'original' as const, publishedAt: '2026-07-23T18:00:00.000Z', inspectorName: 'Faheb Brown' };

  it('excludes inspector-internal notes and includes customer notes', () => {
    const items = fullItems({
      'engine.oil_leaks': {
        result: 'attention',
        inspector_notes: 'INTERNAL-ONLY-SECRET-NOTE',
        customer_note: 'Light seepage — monitor.',
      },
    });
    const snap = JSON.stringify(buildSnapshot(makeReport(), CTX, [], items, [], meta));
    expect(snap).not.toContain('INTERNAL-ONLY-SECRET-NOTE');
    expect(snap).toContain('Light seepage — monitor.');
  });

  it('computes rollups: safety, priorities, negotiation, cost totals, counts', () => {
    const items = fullItems({
      'safety_restraints.seat_belts': { result: 'fail', safety_critical: 1, cost_low_cents: 15000, cost_high_cents: 35000, priority: 'immediate' },
      'tires_wheels.tread_rl': { result: 'attention', negotiation_item: 1, cost_low_cents: 50000, cost_high_cents: 90000, priority: 'soon' },
      'underbody.damage_repair': { result: 'not_inspected', not_inspected_reason: 'not_accessible' },
    });
    const snap = buildSnapshot(makeReport(), CTX, [], items, [], meta) as any;
    expect(snap.rollups.safetyItems).toEqual(['safety_restraints.seat_belts']);
    expect(snap.rollups.soonItems).toEqual(['tires_wheels.tread_rl']);
    expect(snap.rollups.negotiationItems).toEqual(['tires_wheels.tread_rl']);
    expect(snap.rollups.estimatedCostLowCents).toBe(65000);
    expect(snap.rollups.estimatedCostHighCents).toBe(125000);
    expect(snap.rollups.counts.fail).toBe(1);
    expect(snap.rollups.counts.attention).toBe(1);
    expect(snap.rollups.counts.notInspected).toBe(1);
    expect(snap.rollups.counts.pass).toBe(allItemKeys().length - 3);
  });

  it('empties item lists for sections not performed and keeps the reason', () => {
    const sections: SectionRow[] = [
      { section_key: 'road_test', performed: 'not_performed', not_performed_reason: 'seller_declined', summary_note: 'Seller declined a road test.' },
    ];
    const snap = buildSnapshot(makeReport(), CTX, sections, fullItems(), [], meta) as any;
    const rt = snap.sections.find((s: any) => s.key === 'road_test');
    expect(rt.items).toEqual([]);
    expect(rt.notPerformedReason).toBe('seller_declined');
  });

  it('always embeds the standard limitations and the verdict label', () => {
    const snap = buildSnapshot(makeReport(), CTX, [], fullItems(), [], meta) as any;
    expect(snap.limitations.standard).toBe(STANDARD_LIMITATIONS);
    expect(snap.overall.verdictLabel).toBe(VERDICT_LABELS.negotiate_repair_first);
    expect(snap.ref).toBe('PPI-TEST-0001');
  });

  it('excludes soft-deleted photos and maps item photos', () => {
    const photos = [
      { id: 'rph_live', report_id: 'rpt_test', item_key: 'tires_wheels.tread_rl', object_key: 'k1', content_type: 'image/jpeg', size_bytes: 1, width: 640, height: 480, caption: 'Tread', sort: 1, deleted_at: null },
      { id: 'rph_dead', report_id: 'rpt_test', item_key: 'tires_wheels.tread_rl', object_key: 'k2', content_type: 'image/jpeg', size_bytes: 1, width: 640, height: 480, caption: 'Gone', sort: 2, deleted_at: '2026-07-23T00:00:00Z' },
      { id: 'rph_gen', report_id: 'rpt_test', item_key: null, object_key: 'k3', content_type: 'image/jpeg', size_bytes: 1, width: 640, height: 480, caption: 'General', sort: 3, deleted_at: null },
    ];
    const snap = buildSnapshot(makeReport(), CTX, [], fullItems(), photos, meta) as any;
    const rl = snap.sections.flatMap((s: any) => s.items).find((i: any) => i.key === 'tires_wheels.tread_rl');
    expect(rl.photos.map((p: any) => p.id)).toEqual(['rph_live']);
    expect(snap.generalPhotos.map((p: any) => p.id)).toEqual(['rph_gen']);
    expect(JSON.stringify(snap)).not.toContain('rph_dead');
  });
});
