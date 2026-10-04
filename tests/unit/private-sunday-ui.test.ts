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
function calendar(saved: any = {}) {
  const start = admin.indexOf('  function vegasOffsetMinutes(');
  const end = admin.indexOf('  function priceTable(', start);
  const RealDate = Date;
  class FixedDate extends RealDate {
    static now() { return RealDate.parse('2026-10-02T23:00:00Z'); }
  }
  return vm.runInNewContext(admin.slice(start, end) + '\n({ offerableDays, vegasInstant, slateInstants, appointmentChoices, proposalCard, migrateProposalDraft, readAvailability, selectedDates, applyDatePreset, proposalSummary })', { Date: FixedDate, Intl, esc: String, readDraft: () => saved, money: (n: number) => '$' + (n / 100).toFixed(2), priceTable: () => '', tierLabel: String, reviewNoteHtml: () => '' });
}
const cfg = { minLeadHours: 0, maxAdvanceDays: 21, daysOfOperation: [0, 1, 2, 3, 4, 5, 6], blackoutDates: [] };
const normalHours = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];
const example = {
  days: ['2026-10-04', '2026-10-05', '2026-10-06'],
  availability: { '2026-10-04': ['10:00', '13:00', '16:00'], '2026-10-05': ['18:00'], '2026-10-06': ['09:00', '12:00', '15:00', '18:00'] },
};
const expectedInstants = ['2026-10-04T17:00:00.000Z', '2026-10-04T20:00:00.000Z', '2026-10-04T23:00:00.000Z', '2026-10-06T01:00:00.000Z', '2026-10-06T16:00:00.000Z', '2026-10-06T19:00:00.000Z', '2026-10-06T22:00:00.000Z', '2026-10-07T01:00:00.000Z'];
function controls(html: string) {
  const inputs = [...html.matchAll(/<input type="checkbox" ([^>]+)>/g)].map(m => {
    const attrs = Object.fromEntries([...m[1]!.matchAll(/(data-[\w-]+)="([^"]+)"/g)].map(a => [a[1], a[2]]));
    return { checked: /\bchecked\b/.test(m[1]!), getAttribute: (name: string) => attrs[name] ?? null };
  });
  return {
    inputs,
    querySelectorAll: (selector: string) => inputs.filter(i => [...selector.matchAll(/\[([\w-]+)\]/g)].every(m => i.getAttribute(m[1]!) !== null)),
    row: (date: string) => ({ hidden: false, querySelectorAll: () => inputs.filter(i => i.getAttribute('data-date-hour') === date) }),
  };
}

describe('per-date owner proposal choices', () => {
  it('preserves configured weekdays, Tuesday availability, blackouts, and Sunday eligibility', () => {
    const c = calendar();
    const days = c.offerableDays(cfg).map((d: { iso: string }) => d.iso);
    expect(days).toContain('2026-10-04');
    expect(days).toContain('2026-10-06');
    expect(c.offerableDays({ ...cfg, daysOfOperation: [1, 2, 3, 4, 5, 6] }).map((d: { iso: string }) => d.iso)).not.toContain('2026-10-04');
    expect(c.offerableDays({ ...cfg, blackoutDates: ['2026-10-04'] }).map((d: { iso: string }) => d.iso)).not.toContain('2026-10-04');
    expect(c.offerableDays({ ...cfg, daysOfOperation: [1, 3, 4, 5, 6] }).map((d: { iso: string }) => d.iso)).not.toContain('2026-10-06');
  });
  it('converts evening and Sunday times correctly on either side of daylight saving', () => {
    const c = calendar();
    expect(c.vegasInstant('2026-10-04', '13:00')).toBe('2026-10-04T20:00:00.000Z');
    expect(c.vegasInstant('2026-10-04', '18:00')).toBe('2026-10-05T01:00:00.000Z');
    expect(c.vegasInstant('2026-11-01', '18:00')).toBe('2026-11-02T02:00:00.000Z');
  });
  it('renders the same complete 9 AM–6 PM selector per date, showing only selected dates', () => {
    const c = calendar(example);
    const html = c.proposalCard({ proposalDraft: { ...cfg, sundayEligible: true, slotTemplates: ['09:00', '12:30', '16:00'] } });
    const section = controls(html);
    expect(html).toContain('id="bookingProposal"');
    for (const date of example.days) {
      expect(section.row(date).querySelectorAll().map(b => b.getAttribute('data-hour'))).toEqual(normalHours);
      expect(html).toContain(`data-date-card="${date}"><legend>`);
    }
    expect(html).toContain('data-date-card="2026-10-07" hidden');
    expect(html).toContain('>10 AM–6 PM</button>');
    expect(html).toContain('>Afternoon</button>');
    expect(html).toContain('>Clear</button>');
    expect(html).not.toContain('Sunday times');
    expect(html).not.toContain('Monday–Saturday times');
    expect(html).not.toContain('data-sunday-hour');
    expect(html).not.toContain('data-hour="12:30"');
    expect(html).toContain('Send booking proposal');
    const ordinary = c.appointmentChoices({ ...cfg, daysOfOperation: [1, 2, 3, 4, 5, 6] }, example);
    expect(ordinary).not.toContain('data-day="2026-10-04"');
    expect(ordinary).not.toContain('data-date-card="2026-10-04"');
    expect(ordinary).toContain('data-day="2026-10-06"');
  });
  it('offers only exact selected pairs: Monday 6 PM, different Tuesday times, and no Wednesday', () => {
    const c = calendar();
    const section = controls(c.appointmentChoices({ ...cfg, sundayEligible: true }, example));
    expect(c.slateInstants(section, cfg)).toEqual(expectedInstants);
    const summary = c.proposalSummary(c.slateInstants(section, cfg));
    expect(summary).toContain('Sunday, Oct 4:</strong> 10:00 AM, 1:00 PM, 4:00 PM');
    expect(summary).toContain('Monday, Oct 5:</strong> 6:00 PM<br');
    expect(summary).toContain('Tuesday, Oct 6:</strong> 9:00 AM, 12:00 PM, 3:00 PM, 6:00 PM');
    expect(summary).toContain('8 appointment options will be offered.');
    expect(summary).not.toContain('Wednesday');
  });
  it('a per-date preset or Clear changes only its date and preserves the other dates', () => {
    const c = calendar();
    const section = controls(c.appointmentChoices({ ...cfg, sundayEligible: true }, example));
    const selected = (date: string) => section.row(date).querySelectorAll().filter(b => b.checked).map(b => b.getAttribute('data-hour'));
    c.applyDatePreset(section.row('2026-10-06'), 'workday');
    expect(selected('2026-10-06')).toEqual(normalHours.slice(1));
    expect(selected('2026-10-05')).toEqual(['18:00']);
    expect(selected('2026-10-04')).toEqual(example.availability['2026-10-04']);
    c.applyDatePreset(section.row('2026-10-06'), 'clear');
    expect(selected('2026-10-06')).toEqual([]);
    expect(c.selectedDates(section)).toEqual(example.days);
    expect(selected('2026-10-05')).toEqual(['18:00']);
    expect(selected('2026-10-04')).toEqual(example.availability['2026-10-04']);
    c.applyDatePreset(section.row('2026-10-05'), 'afternoons');
    expect(selected('2026-10-05')).toEqual(normalHours.slice(4));
    expect(selected('2026-10-06')).toEqual([]);
  });
  it('binds each preset to its enclosing date instead of the whole proposal', () => {
    const c = calendar();
    const section = controls(c.appointmentChoices({ ...cfg, sundayEligible: true }, example));
    let click: (event: any) => void = () => {};
    let refreshed = 0;
    const start = admin.indexOf('      proposalSection.addEventListener("click", function (event) {');
    const end = admin.indexOf('      refreshSlate();\n      refreshPrice();', start);
    vm.runInNewContext(admin.slice(start, end), {
      proposalSection: { addEventListener: (_: string, fn: (event: any) => void) => { click = fn; }, contains: () => true },
      document: { getElementById: () => ({ textContent: '' }) }, refreshSlate: () => { refreshed++; },
      refreshPrice: () => {}, clearTimeout: () => {}, previewTimer: null, applyDatePreset: c.applyDatePreset,
    });
    click({ target: { closest: () => ({ getAttribute: () => 'workday', closest: () => section.row('2026-10-06') }) } });
    expect(c.readAvailability(section)['2026-10-06']).toEqual(normalHours.slice(1));
    expect(c.readAvailability(section)['2026-10-05']).toEqual(['18:00']);
    expect(refreshed).toBe(1);
  });
  it('keeps deselected-date choices in the draft but excludes them from the outgoing slots', () => {
    const c = calendar();
    const section = controls(c.appointmentChoices({ ...cfg, sundayEligible: true }, example));
    const monday = section.inputs.find(i => i.getAttribute('data-day') === '2026-10-05')!;
    monday.checked = false;
    expect(c.slateInstants(section, cfg)).toEqual(expectedInstants.filter(s => s !== '2026-10-06T01:00:00.000Z'));
    expect(c.readAvailability(section)['2026-10-05']).toEqual(['18:00']);
    monday.checked = true;
    expect(c.slateInstants(section, cfg)).toEqual(expectedInstants);
    expect(c.slateInstants(section, { ...cfg, minLeadHours: 96 })).toEqual(expectedInstants.slice(7));
  });
  it('sends only the exact rendered pairs through the real combined-proposal handler', () => {
    const c = calendar();
    const section = controls(c.appointmentChoices({ ...cfg, sundayEligible: true }, example));
    let click: () => void = () => {};
    const sent: any[] = [];
    const start = admin.indexOf('      sendBtn.addEventListener("click", function () {');
    const end = admin.indexOf('      content.querySelectorAll("[data-resend-proposal]")', start);
    vm.runInNewContext(admin.slice(start, end), {
      sendBtn: { addEventListener: (_: string, fn: () => void) => { click = fn; }, getAttribute: () => '22400' },
      currentForm: () => ({ message: 'Keep this message', internal: 'Private note', expires: '48' }),
      slateInstants: c.slateInstants, proposalSection: section, draftCfg: cfg, MAX_OFFERED_PROPOSAL: 40,
      pricePayload: () => ({ tier: 'standard', basePriceCents: 19900, travelCents: 2500 }),
      detailCache: { request: { year: '2016', make: 'Toyota', model: 'Corolla' } },
      proposalKeyFor: () => 'synthetic-key', statusEl: {}, act: (payload: any) => sent.push(payload),
    });
    click();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: 'send_booking_proposal', slots: expectedInstants, basePriceCents: 19900, travelCents: 2500, customerNote: 'Keep this message', adminNote: 'Private note', expiresHours: 48 });
  });
  it('summarizes only the existing 40-option send limit and clearly flags excess selections', () => {
    const c = calendar();
    const slots = Array.from({ length: 41 }, (_, i) => new Date(Date.parse('2026-10-04T16:00:00Z') + i * 3600000).toISOString());
    expect(c.proposalSummary(slots)).toContain('40 appointment options will be offered.');
    expect(c.proposalSummary(slots)).toContain('only the first 40 shown above will be sent');
  });
});

describe('safe browser draft migration', () => {
  it('copies legacy shared times to their selected dates and retains price/message fields exactly', () => {
    const c = calendar();
    const legacy = { days: example.days, hours: ['12:00', '15:00', '18:00'], sundayHours: ['10:00', '12:30', '16:00'], tier: 'standard', base: '199', travel: '25', message: 'My saved draft', internal: 'Keep note', custom: 'preserve' };
    const upgraded = c.migrateProposalDraft(legacy);
    expect(upgraded).toMatchObject({ availabilityVersion: 2, tier: 'standard', base: '199', travel: '25', message: legacy.message, internal: legacy.internal, custom: legacy.custom });
    expect(upgraded.availability).toEqual({ '2026-10-04': legacy.sundayHours, '2026-10-05': legacy.hours, '2026-10-06': legacy.hours });
    expect(upgraded.hours).toBeUndefined();
    expect(upgraded.sundayHours).toBeUndefined();
    expect(upgraded.availability['2026-10-05']).not.toBe(upgraded.availability['2026-10-06']);
    expect(c.migrateProposalDraft(upgraded)).toEqual(upgraded);
    expect(legacy.hours).toEqual(['12:00', '15:00', '18:00']);
    const section = controls(c.appointmentChoices({ ...cfg, sundayEligible: true }, legacy));
    expect(section.row('2026-10-04').querySelectorAll().filter(b => b.checked).map(b => b.getAttribute('data-hour'))).toEqual(legacy.sundayHours);
  });
  it('preserves cleared and empty drafts, never automatically choosing new dates or times', () => {
    const c = calendar();
    expect(c.migrateProposalDraft({ days: example.days, hours: [], sundayHours: [] }).availability).toEqual({ '2026-10-04': [], '2026-10-05': [], '2026-10-06': [] });
    expect(c.migrateProposalDraft({}).days).toEqual([]);
    const section = controls(c.appointmentChoices({ ...cfg, sundayEligible: true }, {}));
    expect(section.inputs.some(i => i.checked)).toBe(false);
    expect(c.slateInstants(section, cfg)).toEqual([]);
    const perDate = c.migrateProposalDraft(example);
    expect(perDate.availability).toEqual(example.availability);
  });
});

describe('one owner proposal workflow', () => {
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
