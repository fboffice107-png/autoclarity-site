/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
// @ts-expect-error Node builtins are supplied by the Vitest runtime.
import { readFileSync } from 'node:fs';
// @ts-expect-error Node builtins are supplied by the Vitest runtime.
import vm from 'node:vm';
import { DISCOVERY_OPTIONS } from '../../functions/lib/discovery.ts';

const read = (name: string) => readFileSync(new URL('../../' + name, import.meta.url), 'utf8');
const admin = read('assets/js/ppi-admin.js');
const form = read('assets/js/ppi-form.js');
const portal = read('assets/js/ppi-portal.js');
function calendar() {
  const start = admin.indexOf('  function vegasOffsetMinutes(');
  const end = admin.indexOf('  function priceTable(', start);
  const RealDate = Date;
  class FixedDate extends RealDate {
    static now() { return RealDate.parse('2026-10-02T23:00:00Z'); }
  }
  return vm.runInNewContext(admin.slice(start, end) + '\n({ offerableDays, vegasInstant, slateInstants, appointmentChoices, proposalCard })', { Date: FixedDate, Intl, esc: String, readDraft: () => ({}), money: (n: number) => '$' + (n / 100).toFixed(2), priceTable: () => '', tierLabel: String, reviewNoteHtml: () => '' });
}
const cfg = { minLeadHours: 0, maxAdvanceDays: 21, daysOfOperation: [0, 1, 3, 4, 5, 6], blackoutDates: [] };

describe('Sunday owner controls execute with business-local dates', () => {
  it('shows eligible Sunday dates, preserves Tuesday closure, and removes blackouts', () => {
    const c = calendar();
    const days = c.offerableDays(cfg).map((d: { iso: string }) => d.iso);
    expect(days).toContain('2026-10-04');
    expect(days).not.toContain('2026-10-06');
    expect(c.offerableDays({ ...cfg, daysOfOperation: [1, 3, 4, 5, 6] }).map((d: { iso: string }) => d.iso)).not.toContain('2026-10-04');
    expect(c.offerableDays({ ...cfg, blackoutDates: ['2026-10-04'] }).map((d: { iso: string }) => d.iso)).not.toContain('2026-10-04');
  });
  it('converts Sunday afternoon correctly on either side of daylight saving', () => {
    const c = calendar();
    expect(c.vegasInstant('2026-10-04', '13:00')).toBe('2026-10-04T20:00:00.000Z');
    expect(c.vegasInstant('2026-10-04', '17:00')).toBe('2026-10-05T00:00:00.000Z');
    expect(c.vegasInstant('2026-11-01', '16:00')).toBe('2026-11-02T00:00:00.000Z');
  });
  it('offers only admin-ticked Sunday hours, without inheriting weekday defaults', () => {
    const box = (attrs: Record<string, string>, checked = true) => ({ checked, getAttribute: (k: string) => attrs[k] });
    const controls: Record<string, any[]> = {
      '[data-day]': [box({ 'data-day': '2026-10-04' })],
      '[data-hour]': [box({ 'data-hour': '13:00' })],
      '[data-sunday-hour]': [],
    };
    const section = { querySelectorAll: (selector: string) => controls[selector] || [] };
    expect(calendar().slateInstants(section, cfg)).toEqual([]);
    controls['[data-sunday-hour]'] = [box({ 'data-sunday-hour': '16:00' }), box({ 'data-sunday-hour': '12:00' }, false)];
    expect(calendar().slateInstants(section, cfg)).toEqual(['2026-10-04T23:00:00.000Z']);
  });
});

describe('one owner proposal workflow', () => {
  it('puts Sunday days and familiar time chips inside the main proposal, with optional presets', () => {
    const c = calendar();
    const html = c.proposalCard({ proposalDraft: { ...cfg, sundayEligible: true, slotTemplates: ['09:00', '12:30', '16:00'] } });
    expect(html).toContain('id="bookingProposal"');
    expect(html).toContain('data-day="2026-10-04"');
    const normalHours = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];
    expect([...html.matchAll(/data-sunday-hour="([^"]+)"/g)].map(m => m[1])).toEqual(normalHours);
    expect([...html.matchAll(/data-hour="([^"]+)"/g)].map(m => m[1])).toEqual(normalHours);
    expect(html).not.toContain('data-sunday-hour="12:30"');
    for (const label of ['1:00 PM', '2:00 PM', '3:00 PM']) expect(html).toContain(label);
    expect(html).toContain('Select hourly start times: 10 AM–5 PM');
    expect(html).toContain('Start-time presets (optional)');
    expect(html).not.toContain('10\\u201317');
    expect(html).not.toContain('scheduling.slotTemplates');
    expect(html).toContain('Send booking proposal');
    const ordinary = c.proposalCard({ proposalDraft: { ...cfg, daysOfOperation: [1, 2, 3, 4, 5, 6] } });
    expect(ordinary).not.toContain('data-day="2026-10-04"');
    expect(ordinary).not.toContain('data-sunday-hour=');
    expect(ordinary).toContain('data-day="2026-10-06"');
  });
  it('turns the main proposal’s checked Sunday 1, 2, and 3 PM choices into offered instants', () => {
    const c = calendar();
    const saved = { days: ['2026-10-04'], hours: ['09:00'], sundayHours: ['13:00', '14:00', '15:00'] };
    const html = c.appointmentChoices({ ...cfg, sundayEligible: true, slotTemplates: ['09:00', '12:30', '16:00'] }, saved);
    // Read the rendered checkbox choices rather than substituting a separate time list.
    const inputs = [...html.matchAll(/<input type="checkbox" (data-(?:day|hour|sunday-hour))="([^"]+)"( checked)?/g)]
      .map(m => ({ checked: Boolean(m[3]), attr: m[1], getAttribute: (name: string) => name === m[1] ? m[2] : null }));
    const section = { querySelectorAll: (selector: string) => inputs.filter(i => selector === `[${i.attr}]`) };
    expect(c.slateInstants(section, cfg)).toEqual([
      '2026-10-04T20:00:00.000Z', '2026-10-04T21:00:00.000Z', '2026-10-04T22:00:00.000Z',
    ]);
  });
  it('clearly distinguishes private location, dealership Sunday limits, and the collapsed manual email tool', () => {
    expect(admin).toContain('Dealership inspections are fully supported. Sunday appointments are available only for eligible private-sale inspections at a confirmed private residence.');
    expect(admin).not.toContain('A dealership vehicle is never eligible');
    expect(admin).toContain('Seller type:</strong> Private seller');
    expect(admin).toContain('Inspection location &amp; Sunday eligibility');
    expect(admin).toContain('id="jobScheduling"><summary>Advanced scheduling tools</summary>');
    expect(admin).toContain('This does not send the customer’s full quote. Use Send booking proposal above for normal bookings.');
    expect(admin).toContain('>Send appointment options only');
    expect(admin).toContain('payload.action = "send_booking_proposal"');
  });
  async function locationSave(fail = false, navigate = false) {
    let click: () => Promise<void> = async () => {};
    const fields: Record<string, any> = {
      savePrivateLocation: { disabled: false, isConnected: true, addEventListener: (_: string, fn: () => Promise<void>) => { click = fn; } },
      locationSaveStatus: { textContent: '' }, privateLocation: { value: 'private_residence' }, privateInspectionPermission: { checked: true },
    };
    const calls: any[] = [], updates: any[] = [];
    const fresh = { proposalDraft: { ...cfg, sundayEligible: true, slotTemplates: ['09:00', '12:30', '16:00'] } };
    const ctx = { currentRequestId: 'test-request', document: { getElementById: (id: string) => fields[id] },
      api: async (url: string, init?: any) => {
        calls.push({ url, init });
        if (!init && navigate) ctx.currentRequestId = 'another-request';
        return fail ? { ok: false, body: { error: { message: 'Save rejected' } } } : { ok: true, body: init ? {} : fresh };
      } };
    const start = admin.indexOf('  function bindLocationConfirmation(');
    const end = admin.indexOf('  function renderDetail()', start);
    const bind = vm.runInNewContext(admin.slice(start, end) + '\nbindLocationConfirmation', ctx);
    bind((data: any) => updates.push(calendar().appointmentChoices(data.proposalDraft, { days: ['2026-10-05'], hours: ['15:00'] })));
    await click();
    return { fields, calls, updates };
  }
  it('saves only confirmed facts then fetches fresh Sunday availability without a page reload or proposal send', async () => {
    const { fields, calls, updates } = await locationSave();
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0].init.body)).toEqual({ action: 'set_inspection_location', inspectionLocationType: 'private_residence', permInspection: true });
    expect(calls[1]).toEqual({ url: '/api/admin/requests/test-request', init: undefined });
    expect(updates[0]).toContain('data-day="2026-10-04"');
    expect(updates[0]).toContain('data-day="2026-10-05" checked');
    expect(updates[0]).toContain('data-hour="15:00" checked');
    expect(updates[0]).not.toContain('data-day="2026-10-04" checked');
    expect(fields.savePrivateLocation.disabled).toBe(false);
    expect(fields.locationSaveStatus.textContent).toContain('up to date');
  });
  it('does not announce eligibility after failure or overwrite a different request', async () => {
    const failed = await locationSave(true);
    expect(failed.calls).toHaveLength(1); expect(failed.updates).toHaveLength(0);
    expect(failed.fields.locationSaveStatus.textContent).toContain('Save rejected');
    expect((await locationSave(false, true)).updates).toHaveLength(0);
  });
});

describe('small optional discovery widget', () => {
  function widget() {
    const context: { window: any } = { window: {} };
    vm.runInNewContext(read('assets/js/ppi-discovery.js'), context);
    return context.window.AutoClarityDiscovery;
  }
  it('starts blank and never requires a source or explanation', () => {
    const html = widget().render(DISCOVERY_OPTIONS);
    expect(html).toContain('<option value="">');
    expect(html).not.toMatch(/\brequired\b|\bselected\b/);
    expect(html).toContain('maxlength="500"');
    expect(html).toContain('id="discoveryDetailField" hidden');
  });
  it('reveals optional social/other detail and clears stale hidden detail', () => {
    let change = () => {};
    const source = { value: 'instagram', selectedIndex: 1, options: [
      { getAttribute: () => null }, { getAttribute: () => 'social' }, { getAttribute: () => 'other' },
    ], addEventListener: (_: string, fn: () => void) => { change = fn; } };
    const field: any = {}, label: any = {}, detail: any = { value: '' };
    const root = { querySelector: (selector: string) => ({ '#discoverySource': source, '#discoveryDetailField': field, '#discoveryDetail': detail, '#discoveryDetailLabel': label } as Record<string, any>)[selector] };
    const w = widget(); w.bind(root);
    expect(field.hidden).toBe(false); expect(detail.disabled).toBe(false); expect(label.textContent).toContain('video or account');
    source.selectedIndex = 2; source.value = 'other'; change();
    expect(label.textContent).toBe('Where did you hear about us? (Optional)');
    detail.value = 'A flyer'; expect(w.read(root).discoveryDetail).toBe('A flyer');
    source.selectedIndex = 0; source.value = ''; change();
    expect(field.hidden).toBe(true); expect(w.read(root)).toEqual({ discoverySource: '', discoveryDetail: '' });
  });
  it('makes seller selection explicit and prevents hidden dealer names from affecting private requests', () => {
    const html = read('las-vegas-pre-purchase-inspection/index.html');
    const select = html.slice(html.indexOf('<select id="sellerType"'), html.indexOf('</select>', html.indexOf('<select id="sellerType"')));
    expect(select).toContain('required'); expect(select).toContain('<option value="">'); expect(select).not.toContain('selected');
    const controls: Record<string, any> = { sellerType: { value: 'dealership' }, dealershipName: { value: 'Example' }, inspectionLocationType: { value: '' } };
    const fields: Record<string, any> = { dealershipNameField: {}, inspectionLocationField: {} };
    const start = form.indexOf('  function updateSellerFields()');
    const end = form.indexOf('  function setupSellerFields()', start);
    const update = vm.runInNewContext(form.slice(start, end) + '\nupdateSellerFields', { form: { elements: controls }, val: (key: string) => controls[key].value, document: { getElementById: (key: string) => fields[key] } });
    update(); expect(fields.dealershipNameField.hidden).toBe(false);
    controls.sellerType.value = 'private'; update();
    expect(fields.dealershipNameField.hidden).toBe(true); expect(controls.dealershipName.value).toBe('');
    expect(controls.dealershipName.disabled).toBe(true); expect(fields.inspectionLocationField.hidden).toBe(false);
  });
  it('uses saved state to suppress repeat questions and attaches answers to existing approval actions', () => {
    expect(portal).toContain('!(v.discovery && v.discovery.source)');
    expect(portal).toContain('["select_slot", "accept_agreements", "checkout"].indexOf(payload.action)');
    expect(portal).toContain('Object.assign(payload, window.AutoClarityDiscovery.read(elContent))');
    expect(admin).toContain('esc(d.discoveryLabel || "Not provided")');
    expect(admin).toContain('esc(req.discovery_detail)');
  });
});
