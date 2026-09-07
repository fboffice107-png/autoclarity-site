/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';
import page from '../../las-vegas-pre-purchase-inspection/index.html?raw';
import script from '../../assets/js/ppi-form.js?raw';
import portalScript from '../../assets/js/ppi-portal.js?raw';
import portalAction from '../../functions/api/portal/action.ts?raw';
import intakeApi from '../../functions/api/ppi/requests.ts?raw';
import mainScript from '../../assets/js/main.js?raw';
import adminScript from '../../assets/js/ppi-admin.js?raw';
import sitemap from '../../sitemap.xml?raw';

describe('PPI frontend conversion safeguards', () => {
  it('uses one canonical trailing-slash URL and valid local-service schema', () => {
    expect(page).toContain('<link rel="canonical" href="https://getautoclarity.com/las-vegas-pre-purchase-inspection/" />');
    expect(sitemap).toContain('<loc>https://getautoclarity.com/las-vegas-pre-purchase-inspection/</loc>');
    expect(sitemap).not.toContain('<loc>https://getautoclarity.com/las-vegas-pre-purchase-inspection</loc>');

    const description = page.match(/<meta name="description" content="([^"]+)"/u)?.[1] ?? '';
    expect(description.length).toBeGreaterThan(100);
    expect(description.length).toBeLessThanOrEqual(160);

    const blocks = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gu)];
    expect(blocks).toHaveLength(3);
    const graph = JSON.parse(blocks[0]![1]!) as { '@graph': Array<{ '@type': string; url?: string; areaServed?: Array<{ name: string }> }> };
    const service = graph['@graph'].find((node) => node['@type'] === 'Service')!;
    expect(service.url).toBe('https://getautoclarity.com/las-vegas-pre-purchase-inspection/');
    expect(service.areaServed!.map((place) => place.name)).toEqual(
      expect.arrayContaining(['Las Vegas', 'North Las Vegas', 'Henderson', 'Boulder City', 'Clark County']),
    );
  });

  it('renders a safe, exact confirmation receipt only after persistence', () => {
    for (const id of ['successTitle', 'successEmailNotice', 'successRefRow', 'successPortalLink', 'successSummary']) {
      expect(page).toContain(`id="${id}"`);
    }
    expect(script).toContain('detail.textContent =');
    expect(script).toContain('link.hidden = !token');
    expect(script).toContain('track("ppi_form_completed", "request_saved")');
    expect(script).toContain('track("request_confirmation_viewed", "request_saved")');

    const emailHandoff = script.slice(script.indexOf('function submitToEmail()'), script.indexOf('/* ---------- success + uploads ---------- */'));
    expect(emailHandoff).not.toContain('clearDraft()');
    expect(emailHandoff).not.toContain('showSuccess(');
    expect(emailHandoff).not.toContain('ppi_request_submitted');
    expect(emailHandoff).toContain('Your request has not been received yet');
  });

  it('describes uncertain email delivery honestly and adapts correction instructions', () => {
    expect(script).toContain('delivery of the confirmation email to " + email + " is not yet confirmed');
    expect(script).not.toContain('still being processed');
    expect(script).toContain('if (emailState === "sent")');
    expect(script).toContain('use your secure status page or email support@getautoclarity.com');
    expect(script).toContain('email support@getautoclarity.com and include the reference above');
  });

  it('expires local drafts and reuses one submission key across uncertain retries', () => {
    expect(page).toContain('id="draftClearBtn"');
    expect(page).toContain('saved in this browser for up to 7 days');
    expect(script).toContain('var DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;');
    expect(script).toContain('_savedAt: Date.now()');
    expect(script).toContain('_submissionKey: ensureSubmissionKey()');
    expect(script).toContain('submissionKey: ensureSubmissionKey()');
    expect(script).toContain('/^[A-Za-z0-9_-]{16,128}$/');

    const duplicateBranch = script.slice(script.indexOf('if (duplicate) {'), script.indexOf('} else {', script.indexOf('if (duplicate) {')));
    expect(duplicateBranch).not.toContain('clearDraft()');
    const uncertainBranch = script.slice(script.indexOf('.catch(function (error)'), script.indexOf('var STEP_OF_FIELD'));
    expect(uncertainBranch).not.toContain('clearDraft()');
  });

  it('preserves allowlisted first-touch attribution from homepage to the PPI form', () => {
    for (const source of [mainScript, script]) {
      expect(source).toContain('ppi-attribution-v1');
      expect(source).toContain('utm_source');
      expect(source).toContain('utm_medium');
      expect(source).not.toContain('params.get("utm_campaign")');
      expect(source).toContain('source: "referral", medium: "referral"');
    }
    expect(mainScript).toContain('sessionStorage.setItem(attributionKey, result)');
    expect(mainScript).toContain('source: ppiAttribution');
    expect(mainScript).not.toContain('source: "homepage"');
    expect(script).toContain('if (isAllowedAttribution(saved)) return saved');
    expect(script).toContain('attributionSource: attributionSource');
  });

  it('shows the exact conversion events and makes notification issues actionable in admin', () => {
    expect(adminScript).toContain('"ppi_form_completed"');
    expect(adminScript).toContain('"request_confirmation_viewed"');
    expect(adminScript).toContain('id="notificationIssuesBtn"');
    expect(adminScript).toContain('id="notificationIssuesPanel"');
    expect(adminScript).toContain('data.notificationIssueRequests || []');
    expect(adminScript).toContain('review its Messages section to retry delivery');
    expect(adminScript).toContain('If no failed email row appears');
    expect(adminScript).toContain('the action was not confirmed');
    expect(adminScript).toContain('email_retry_window_expired');
    expect(adminScript).toContain('requiresFreshConfirmation');
    expect(adminScript).toContain('confirmFresh: confirmFresh === true');
    expect(adminScript).toContain('provider’s duplicate protection has expired');
    expect(adminScript).toContain('Verified service funnel (30 days)');
    expect(adminScript).toContain('Gross collected (30d)');
    expect(adminScript).toContain('Net collected (30d)');
    expect(adminScript).toContain('Request cohorts by source (30 days)');
    expect(intakeApi).toContain("surfaceIntakeNotificationFailure(env.DB, requestId, customerEmail, 'request_received'");
    expect(intakeApi).toContain("surfaceIntakeNotificationFailure(env.DB, requestId, ownerEmail, 'owner_new_request'");
  });

  it('keeps response-time and payments-off language truthful by default', () => {
    expect(page).not.toMatch(/normally receive|never later than|hear back the same day/iu);
    expect(page).toContain('typically responds within 24 hours with scheduling details');
    expect(page).toContain('<div data-payment="off">');
    expect(page).toContain('<div data-payment="on" hidden>');
    expect(page).not.toContain('physical services paid through this website');
    expect(page).toContain('<span data-payment="off">Submitting is free.');
    expect(page).toContain('<span data-payment="on" hidden>After review, you can select a time');
    expect(script).toContain('cfg.paymentsEnabled === true');
    expect(portalScript).not.toMatch(/hear back the same day|never later than|preview environment/iu);
    expect(portalScript).toContain('v.paymentsEnabled');
    expect(portalScript).toContain('Online payment is currently unavailable');
    expect(portalScript).toContain('no appointment time was booked');
    expect(portalAction).toContain("'payments_unavailable'");
    expect(portalAction).toContain('no charge was started');
    expect(portalAction).not.toContain('preview environment');
  });
});
