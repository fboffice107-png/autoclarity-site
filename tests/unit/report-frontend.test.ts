/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
// @ts-expect-error node:fs is test-only, outside the Worker type surface.
import { readFileSync } from 'node:fs';
import rendererScript from '../../assets/js/ppi-report-view.js?raw';
import editorScript from '../../assets/js/ppi-report-editor.js?raw';
import portalScript from '../../assets/js/ppi-portal.js?raw';
import adminScript from '../../assets/js/ppi-admin.js?raw';
import redirects from '../../_redirects?raw';
const reportCss = readFileSync(new URL('../../assets/css/ppi-report.css', import.meta.url), 'utf8');

interface PhotoDisposer { (): void; ready: Promise<{total: number; failed: number}>; loadAll(): Promise<{total: number; failed: number}> }
interface Renderer { render: (report: unknown, options?: {preview: boolean}) => string; resultLabel: (result: string) => string; hydrate(root: unknown, fetchPhoto: (id: string, signal: AbortSignal) => Promise<Blob>): PhotoDisposer }
function renderer(): Renderer {
  const window: {AutoClarityReportView?: Renderer} = {};
  new Function('window', rendererScript)(window);
  return window.AutoClarityReportView!;
}
function fixture() {
  return {
    version: 2, amended: true, publishedAt: '2026-09-11T19:10:00.000Z',
    payload: {
      inspector: 'Test Inspector', inspectedAt: '2026-09-11T17:00:00.000Z',
      vehicle: {year: 2020, make: 'Example', model: 'Sedan', vin: 'TEST-VIN'},
      overall: {score: 9, verdict: 'do_not_proceed', executiveSummary: 'Safety concern needs attention.', positiveFindings: 'Interior condition.', negotiationSummary: 'Seek a written repair estimate.'},
      sections: [{title: 'Brakes', performed: 'partial', notPerformedReason: 'not_accessible', summary: 'Accessible components only.', items: [{label: 'Brake inspection', result: 'attention', note: 'Visible concern.', priority: 'immediate', photos: [{id: 'rp_fixture', caption: 'Brake component'}]}]}],
      limitations: {standard: ['No disassembly.'], additional: 'Road test not authorized.'},
    },
  };
}

describe('customer report presentation', () => {
  it('renders the same professional identity, version, findings and limitations for portal and preview', () => {
    const output = renderer().render(fixture());
    for (const text of ['AUTOCLARITY', 'Pre-purchase inspection report', '2020 Example Sedan', 'TEST-VIN', 'Test Inspector', 'amendment', 'Executive summary', 'Brake inspection', 'Road test not authorized.', 'No disassembly.']) expect(output).toContain(text);
    expect(output).toContain('Comprehensive multi-point');
    expect(output).not.toMatch(/\b(?:160|130)-point/);
  });

  it('preserves human guidance independent of numeric score', () => {
    const report = fixture();
    expect(renderer().render(report)).toContain('Do Not Proceed');
    report.payload.overall.score = 1;
    expect(renderer().render(report)).toContain('Do Not Proceed');
    expect(renderer().render(report)).not.toContain('>Proceed<');
  });

  it('escapes injected values in every supported text and photo attribute surface', () => {
    const attack = '\"><img src=x onerror=alert(1)>&\'';
    const report = fixture();
    report.payload.inspector = attack;
    report.payload.vehicle.vin = attack;
    report.payload.overall.executiveSummary = attack;
    report.payload.sections[0]!.title = attack;
    report.payload.sections[0]!.items[0]!.note = attack;
    report.payload.sections[0]!.items[0]!.photos[0] = {id: attack, caption: attack};
    const output = renderer().render(report);
    expect(output).not.toContain(attack);
    expect(output).not.toContain('<img src=x');
    expect(output).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&amp;&#39;');
    expect(output).not.toMatch(/\s(?:src|onerror)="x/);
  });

  it('never renders internal notes, object keys, tokens or unsupported snapshot fields', () => {
    const report = fixture();
    const source = { ...report, token: 'SECRET_BEARER', payload: {...report.payload, internalNotes: 'PRIVATE_NOTE', object_key: 'PRIVATE_BUCKET_KEY', sections: [{...report.payload.sections[0], items: [{...report.payload.sections[0]!.items[0], internalNotes: 'PRIVATE_ITEM_NOTE', photos: [{id: 'photo', caption: 'Allowed', object_key: 'PRIVATE_OBJECT', url: 'https://example.invalid/SECRET_URL'}]}]}]} };
    const output = renderer().render(source);
    for (const marker of ['SECRET_BEARER', 'PRIVATE_NOTE', 'PRIVATE_BUCKET_KEY', 'PRIVATE_ITEM_NOTE', 'PRIVATE_OBJECT', 'SECRET_URL']) expect(output).not.toContain(marker);
    expect(output).toContain('data-report-photo="photo"');
    expect(output).not.toContain('src=');
  });

  it('supports every explicit finding state and contains unrecognized state CSS', () => {
    const report = fixture();
    for (const state of ['pass', 'attention', 'fail', 'not_inspected', 'not_accessible', 'not_applicable']) {
      report.payload.sections[0]!.items[0]!.result = state;
      expect(renderer().render(report)).toContain('result-' + state);
    }
    report.payload.sections[0]!.items[0]!.result = '\" onclick=alert(1)';
    expect(renderer().render(report)).toContain('result-unset');
    expect(renderer().render(report)).not.toContain('class="report-result result-" onclick');
  });

  it('marks previews unpublished and does not pretend a missing recommendation is valid', () => {
    const report = fixture(); report.payload.overall.verdict = '';
    const output = renderer().render(report, {preview: true});
    expect(output).toContain('Owner preview — unpublished draft');
    expect(output).toContain('Not published');
    expect(output).toContain('Not recorded');
  });

  it('retains legacy captions even when no private image identifier is present', () => {
    const report = fixture();
    const legacy = { ...report, payload: {...report.payload, sections: [{...report.payload.sections[0], items: [{...report.payload.sections[0]!.items[0], photos: [{caption: 'Historic recorded caption'}]}]}]} };
    const output = renderer().render(legacy);
    expect(output).toContain('Historic recorded caption');
    expect(output).not.toContain('data-report-photo=');
  });
});

describe('private photo loading', () => {
  function harness() {
    const elements = Array.from({length: 5}, (_, i) => ({
      id: `photo_${i}`, isConnected: true, src: '', hidden: false,
      getAttribute() { return this.id; },
      parentElement: { querySelector() { return {textContent: ''}; } },
    }));
    let intersection: (values: unknown[]) => void = () => {};
    let disconnected = false;
    class Observer {
      constructor(callback: (values: unknown[]) => void) { intersection = callback; }
      observe() { /* Test explicitly chooses which photos approach viewport. */ }
      unobserve() { /* No new intersection is queued by this fixture. */ }
      disconnect() { disconnected = true; }
    }
    const revoked: string[] = [];
    let counter = 0;
    const window: {AutoClarityReportView?: Renderer} = {};
    new Function('window', 'IntersectionObserver', 'URL', rendererScript)(window, Observer, {
      createObjectURL() { return `blob:test-${++counter}`; },
      revokeObjectURL(url: string) { revoked.push(url); },
    });
    return {elements, revoked, renderer: window.AutoClarityReportView!, root: {querySelectorAll() { return elements; }},
      intersect() { intersection([{isIntersecting: true, target: elements[0]}]); }, isDisconnected: () => disconnected};
  }
  async function tick() { await new Promise((resolve) => setTimeout(resolve, 0)); }

  it('loads only near-view photos with at most two fetches; print loads all and cleanup revokes blobs', async () => {
    const test = harness();
    const completions: Array<() => void> = [];
    let active = 0, maxActive = 0, started = 0;
    const disposer = test.renderer.hydrate(test.root, async () => {
      started++; active++; maxActive = Math.max(maxActive, active);
      return new Promise<Blob>((resolve) => completions.push(() => { active--; resolve(new Blob(['photo'], {type: 'image/png'})); }));
    });
    await tick(); expect(started).toBe(0);
    test.intersect(); await tick(); expect(started).toBe(1);
    const printed = disposer.loadAll(); await tick(); expect(started).toBe(2);
    for (let i = 0; i < 5; i++) { completions.shift()!(); await tick(); }
    expect(await printed).toEqual({total: 5, failed: 0});
    expect(maxActive).toBe(2);
    expect(test.elements.every((img) => img.src.startsWith('blob:test-'))).toBe(true);
    disposer(); expect(test.revoked).toHaveLength(5); expect(test.isDisconnected()).toBe(true);
  });

  it('reports unavailable photos to the print gate and aborts in-flight work on view disposal', async () => {
    const test = harness(); let signal: AbortSignal | null = null;
    const disposer = test.renderer.hydrate(test.root, async (_id, value) => { signal = value; throw new Error('Not authorized'); });
    const result = await disposer.loadAll();
    expect(result).toEqual({total: 5, failed: 5});
    expect(test.elements.every((img) => img.hidden)).toBe(true);
    disposer(); expect((signal as unknown as AbortSignal).aborted).toBe(true);
  });
});

describe('integrated frontend workflow contracts', () => {
  it('keeps report credentials out of URLs and requires authenticated private photo fetches', () => {
    expect(portalScript).toContain('"/api/portal/report-photo?id="');
    expect(portalScript).toContain('"&versionId=" + encodeURIComponent(v.report.versionId)');
    expect(portalScript).toContain('headers: { authorization: "Bearer " + token }, cache: "no-store"');
    expect(portalScript).not.toMatch(/report-photo[^\n]*[?&]t=/);
    expect(rendererScript).toContain('URL.revokeObjectURL(url)');
    expect(adminScript).toContain('AutoClarityReportEditor.mount');
  });

  it('uses acknowledged sequence numbers, preserves unsaved edits and invalidates stale previews', () => {
    expect(editorScript).toContain('action: "save", seq: seq, draft: snapshot');
    expect(editorScript).toContain('if (pending) return pending.then');
    expect(editorScript).toContain('dirty !== saved ? save() : ok');
    expect(editorScript).toContain('conflict = error.status === 409');
    expect(editorScript).toContain('Your edits are still on this screen');
    expect(editorScript).toContain('window.addEventListener("beforeunload"');
    expect(editorScript).toContain('previewOpen = false');
    expect(editorScript).not.toContain('localStorage.setItem');
  });

  it('offers private print/PDF and a mobile stacked layout with accessible operational controls', () => {
    expect(portalScript).toContain('window.print()');
    expect(portalScript).toContain('await reportPhotoDispose.loadAll()');
    expect(reportCss).toContain('@media print');
    expect(reportCss).toContain('body.printing-report #portalContent > :not(.customer-report)');
    expect(reportCss).toContain('.admin-mobile-cards td::before');
    expect(adminScript).toContain('aria-label="Job sections"');
    expect(editorScript).toContain('aria-live="polite"');
  });

  it('routes the protected inspector entry point into the existing admin, without another app', () => {
    expect(redirects).toContain('/inspector /ppi/admin/ 302');
    expect(redirects).toContain('/inspector/ /ppi/admin/ 302');
  });
});

function dialogHarness(autoAnswer?: boolean) {
  type Event = {preventDefault(): void; key?: string; shiftKey?: boolean};
  type Handler = (event: Event) => void;
  let focusRestored = 0, removed = false;
  const previous = {isConnected: true, focus() { focusRestored++; }};
  function control() {
    return {value: '', textContent: '', isConnected: true, listeners: {} as Record<string, Handler>,
      focus() { document.activeElement = this; },
      addEventListener(name: string, handler: Handler) { this.listeners[name] = handler; }};
  }
  const cancel = control(), submit = control(), reason = control(), form = control(), error = control();
  const dialog = {open: false, innerHTML: '', className: '', attributes: {} as Record<string, string>, listeners: {} as Record<string, Handler>,
    setAttribute(key: string, value: string) { this.attributes[key] = value; },
    querySelector(selector: string) { return selector === 'form' ? form : selector === 'textarea' ? reason : selector === '#reportConfirmError' ? error : cancel; },
    querySelectorAll() { return this.innerHTML.includes('reportAmendReason') ? [reason, cancel, submit] : [cancel, submit]; },
    addEventListener(name: string, handler: Handler) { this.listeners[name] = handler; },
    showModal() { this.open = true; }, close() { this.open = false; this.listeners.close?.({preventDefault() {}}); }, remove() { removed = true; }};
  const document: {activeElement: {isConnected: boolean; focus(): void}; createElement(): typeof dialog; body: {appendChild(): void}} = {
    activeElement: previous, createElement() { return dialog; },
    body: {appendChild() { if (autoAnswer !== undefined) Promise.resolve().then(() => (autoAnswer ? form.listeners.submit : cancel.listeners.click)!({preventDefault() {}})); }} };
  return {document, dialog, cancel, submit, reason, form, error, restored: () => focusRestored, removed: () => removed};
}

describe('accessible report confirmations', () => {
  function setup(reason = false) {
    const test = dialogHarness();
    const window: Record<string, unknown> = {AutoClarityReportView: {escape: (value: unknown) => String(value)}};
    new Function('window', 'document', editorScript)(window, test.document);
    const editor = window.AutoClarityReportEditor as {confirmation(options: unknown): {answer: Promise<boolean | string | null>; cancel(): void}};
    const modal = editor.confirmation({title: 'Confirm report action', text: 'Published evidence is preserved.', label: 'Explicit confirmation', reason});
    return {...test, modal};
  }
  it('shows an explicitly named modal, focuses Cancel, and resolves only after confirmation', async () => {
    const test = setup();
    expect(test.dialog.open).toBe(true);
    expect(test.dialog.attributes['aria-labelledby']).toBe('reportConfirmTitle');
    expect(test.dialog.attributes['aria-describedby']).toBe('reportConfirmDescription');
    expect(test.document.activeElement).toBe(test.cancel);
    expect(test.dialog.innerHTML).toContain('Explicit confirmation');
    test.form.listeners.submit!({preventDefault() {}});
    expect(await test.modal.answer).toBe(true);
    expect(test.removed()).toBe(true); expect(test.restored()).toBe(1);
  });
  it('cancels with Escape or Cancel and restores focus without authorizing the action', async () => {
    const escape = setup();
    escape.dialog.listeners.keydown!({key: 'Escape', preventDefault() {}});
    expect(await escape.modal.answer).toBeNull(); expect(escape.restored()).toBe(1);
    const cancel = setup(); cancel.cancel.listeners.click!({preventDefault() {}});
    expect(await cancel.modal.answer).toBeNull(); expect(cancel.restored()).toBe(1);
  });
  it('traps keyboard traversal and validates the retained amendment reason before resolving', async () => {
    const test = setup(true);
    expect(test.document.activeElement).toBe(test.reason);
    test.dialog.listeners.keydown!({key: 'Tab', shiftKey: true, preventDefault() {}});
    expect(test.document.activeElement).toBe(test.submit);
    test.dialog.listeners.keydown!({key: 'Tab', preventDefault() {}});
    expect(test.document.activeElement).toBe(test.reason);
    test.reason.value = 'bad'; test.form.listeners.submit!({preventDefault() {}});
    expect(test.dialog.open).toBe(true); expect(test.error.textContent).toContain('at least five characters');
    test.reason.value = ' Correct the draft caption. '; test.form.listeners.submit!({preventDefault() {}});
    expect(await test.modal.answer).toBe('Correct the draft caption.');
  });
});

describe('report autosave controller', () => {
  function harness(settings: {photos?: Array<{id: string; caption: string; referenced: boolean}>; state?: string; confirm?: boolean} = {}) {
    type Handler = () => void;
    const modalTest = dialogHarness(settings.confirm || false);
    let removeDisabled = false, removeFocused = 0, focusWhileDisabled = 0, headingFocused = 0;
    const field = {type: 'textarea', value: 'Initial summary', disabled: false, listeners: {} as Record<string, Handler>,
      getAttribute(name: string) { return name === 'data-field' ? 'executiveSummary' : null; },
      addEventListener(name: string, handler: Handler) { this.listeners[name] = handler; }};
    const saveButton = {disabled: false, listeners: {} as Record<string, Handler>,
      getAttribute() { return 'save'; }, addEventListener(name: string, handler: Handler) { this.listeners[name] = handler; }};
    const removeButton = {isConnected: true, listeners: {} as Record<string, Handler>,
      get disabled() { return removeDisabled; },
      set disabled(value: boolean) { removeDisabled = value; if (value && modalTest.document.activeElement === this) modalTest.document.activeElement = {isConnected: true, focus() {}}; },
      focus() { if (this.disabled) { focusWhileDisabled++; return; } removeFocused++; modalTest.document.activeElement = this; },
      getAttribute() { return settings.photos?.[0]?.id || ''; }, addEventListener(name: string, handler: Handler) { this.listeners[name] = handler; }};
    const status = {textContent: '', classList: {toggle() { /* presentation only */ }}};
    const fields = {disabled: false};
    const root = {innerHTML: '',
      querySelector(selector: string) { if (selector === '#reportSaveStatus') return status; if (selector === '#reportFields') return fields; if (selector === '#reportHeading') return {focus() { headingFocused++; }}; return null; },
      querySelectorAll(selector: string) { if (selector === '[data-field]') return [field]; if (selector === '[data-report-action]' || selector === '[data-report-action], [data-add-finding], #reportUpload') return [saveButton]; if (selector === '[data-remove-report-photo]' && this.innerHTML.includes('data-remove-report-photo=')) return [removeButton]; return []; }};
    const draft = {inspectorName: 'Inspector', inspectedAt: '2026-09-11T17:00:00Z', score: 5, verdict: 'proceed', executiveSummary: 'Initial summary', sections: []};
    function response(seq: number, nextDraft: unknown = draft) { return {report: {id: 'report_fixture', state: settings.state || 'in_progress', seq, draft: nextDraft, photos: settings.photos || [], versions: []}, requestStatus: 'inspection_in_progress'}; }
    const calls: Array<{payload: {action: string; seq: number; draft?: {executiveSummary: string}; photoId?: string}, resolve: (result: unknown) => void}> = [];
    const api = async (_path: string, options?: {body: string}) => {
      if (!options) return {ok: true, body: response(0)};
      return new Promise((resolve) => calls.push({payload: JSON.parse(options.body), resolve}));
    };
    const window: Record<string, unknown> = {
      AutoClarityReportView: {escape: (value: unknown) => String(value ?? ''), hydrate: () => () => {}},
      addEventListener() {}, removeEventListener() {}, confirm: () => settings.confirm || false,
    };
    new Function('window', 'document', 'setTimeout', 'clearTimeout', editorScript)(window, modalTest.document, () => 0, () => {});
    const editor = window.AutoClarityReportEditor as {mount(root: unknown, config: unknown): {canLeave(): boolean; dispose(): void}};
    const controller = editor.mount(root, {requestId: 'request_fixture', api, fetchPhoto: () => { throw new Error('No fixture photos'); }});
    return {calls, response, controller, field, fields, status, removeButton, focusResult: () => ({removeFocused, focusWhileDisabled, headingFocused}), markup: () => root.innerHTML, remove() { removeButton.focus(); removeButton.listeners.click!(); }, edit(value: string) { field.value = value; field.listeners.input!(); }, save() { saveButton.listeners.click!(); }};
  }
  async function tick() { await new Promise((resolve) => setTimeout(resolve, 0)); }

  it('serializes in-flight saves and sends new edits only with the acknowledged sequence', async () => {
    const test = harness(); await tick();
    test.edit('First edit'); test.save(); await tick();
    expect(test.calls).toHaveLength(1); expect(test.calls[0]!.payload).toMatchObject({seq: 0, draft: {executiveSummary: 'First edit'}});
    test.edit('Newer edit while saving'); test.save(); await tick();
    expect(test.calls).toHaveLength(1); expect(test.controller.canLeave()).toBe(false);
    test.calls[0]!.resolve({ok: true, body: test.response(1, test.calls[0]!.payload.draft)}); await tick();
    expect(test.calls).toHaveLength(2); expect(test.calls[1]!.payload).toMatchObject({seq: 1, draft: {executiveSummary: 'Newer edit while saving'}});
    test.calls[1]!.resolve({ok: true, body: test.response(2, test.calls[1]!.payload.draft)}); await tick();
    expect(test.status.textContent).toBe('All changes saved securely.'); expect(test.controller.canLeave()).toBe(true);
    test.controller.dispose();
  });

  it('keeps the local draft on a conflict, blocks further writes and requires explicit recovery', async () => {
    const test = harness(); await tick();
    test.edit('Unsaved owner findings'); test.save(); await tick();
    test.calls[0]!.resolve({ok: false, status: 409, body: {error: {message: 'Changed concurrently'}}}); await tick();
    expect(test.status.textContent).toContain('Your edits are still on this screen');
    expect(test.field.value).toBe('Unsaved owner findings'); expect(test.fields.disabled).toBe(true);
    test.save(); await tick(); expect(test.calls).toHaveLength(1); expect(test.controller.canLeave()).toBe(false);
    test.controller.dispose();
  });

  it('removes only an explicitly unreferenced draft photo after confirmation with the current sequence', async () => {
    const test = harness({photos: [{id: 'photo_unpublished', caption: 'Wrong draft photo', referenced: false}], confirm: true}); await tick();
    expect(test.markup()).toContain('data-remove-report-photo="photo_unpublished"');
    test.remove(); await tick();
    expect(test.calls).toHaveLength(1);
    expect(test.calls[0]!.payload).toEqual({action: 'remove_photo', seq: 0, photoId: 'photo_unpublished'});
    const response = test.response(1); response.report.photos = [];
    test.calls[0]!.resolve({ok: true, body: response}); await tick();
    expect(test.markup()).not.toContain('data-remove-report-photo=');
    expect(test.status.textContent).toContain('private file and audit record are retained');
    test.controller.dispose();
  });

  it('never offers removal for published evidence or outside the editable draft, and honors cancel', async () => {
    for (const settings of [
      {photos: [{id: 'photo_published', caption: 'Published photo', referenced: true}]},
      {photos: [{id: 'photo_draft', caption: 'Draft photo', referenced: false}], state: 'ready_for_review'},
    ]) {
      const test = harness(settings); await tick(); expect(test.markup()).not.toContain('data-remove-report-photo='); test.controller.dispose();
    }
    const cancelled = harness({photos: [{id: 'photo_draft', caption: 'Draft photo', referenced: false}]}); await tick();
    cancelled.remove(); await tick(); expect(cancelled.calls).toHaveLength(0); cancelled.controller.dispose();
  });
  it('restores the explicit trigger only after re-enabling it, even when disabling moves active focus', async () => {
    const cancelled = harness({photos: [{id: 'photo_draft', caption: 'Draft photo', referenced: false}]}); await tick();
    cancelled.remove(); await tick();
    expect(cancelled.calls).toHaveLength(0);
    expect(cancelled.focusResult()).toEqual({removeFocused: 2, focusWhileDisabled: 0, headingFocused: 0});
    cancelled.controller.dispose();
    const confirmed = harness({photos: [{id: 'photo_draft', caption: 'Draft photo', referenced: false}], confirm: true}); await tick();
    confirmed.remove(); await tick();
    confirmed.removeButton.isConnected = false; // Successful render removes the originating photo button.
    const next = confirmed.response(1); next.report.photos = [];
    confirmed.calls[0]!.resolve({ok: true, body: next}); await tick();
    expect(confirmed.focusResult()).toEqual({removeFocused: 1, focusWhileDisabled: 0, headingFocused: 1});
    confirmed.controller.dispose();
  });
});

describe('report notification feedback', () => {
  function notification(result: unknown) {
    const window: Record<string, unknown> = {AutoClarityReportView: {escape: (value: unknown) => String(value)}};
    new Function('window', editorScript)(window);
    return (window.AutoClarityReportEditor as {notificationStatus(value: unknown): {text: string; attention: boolean}}).notificationStatus(result);
  }
  it('distinguishes provider-sent from recorded, pending and failed instead of claiming delivery', () => {
    expect(notification({emailStatus: 'sent'})).toMatchObject({attention: false});
    expect(notification({emailStatus: 'sent'}).text).toContain('sent to the email provider');
    expect(notification({emailStatus: 'recorded'}).text).toContain('sending is not yet confirmed');
    expect(notification({emailStatus: 'pending'}).text).toContain('notification is pending');
    expect(notification({emailStatus: 'failed'}).text).toContain('email failed');
    for (const status of ['recorded', 'pending', 'failed', 'unknown']) expect(notification({emailStatus: status}).attention).toBe(true);
  });
  it('shows the owner-only fresh-retry warning without implicitly approving a new email', () => {
    const output = notification({emailStatus: 'failed', warning: 'Older than 24 hours: check provider history, then explicitly confirm a fresh retry in Messages.'});
    expect(output.text).toContain('explicitly confirm a fresh retry in Messages');
    expect(output.attention).toBe(true);
    expect(editorScript).not.toContain('confirmFresh: true');
  });
});
