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
  const end = admin.indexOf('  function proposalCard(', start);
  const RealDate = Date;
  class FixedDate extends RealDate {
    static now() { return RealDate.parse('2026-10-02T23:00:00Z'); }
  }
  return vm.runInNewContext(admin.slice(start, end) + '\n({ offerableDays, vegasInstant, slateInstants })', { Date: FixedDate, Intl });
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
  it('offers only admin-ticked Sunday templates, without inheriting weekday defaults', () => {
    const box = (attrs: Record<string, string>, checked = true) => ({ checked, getAttribute: (k: string) => attrs[k] });
    const controls: Record<string, any[]> = {
      '[data-day]': [box({ 'data-day': '2026-10-04' })],
      '[data-hour]': [box({ 'data-hour': '13:00' })],
      '[data-sunday-hour]': [],
    };
    const section = { querySelectorAll: (selector: string) => controls[selector] || [] };
    expect(calendar().slateInstants(section, cfg)).toEqual([]);
    controls['[data-sunday-hour]'] = [box({ 'data-sunday-hour': '16:00' }), box({ 'data-sunday-hour': '12:30' }, false)];
    expect(calendar().slateInstants(section, cfg)).toEqual(['2026-10-04T23:00:00.000Z']);
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
