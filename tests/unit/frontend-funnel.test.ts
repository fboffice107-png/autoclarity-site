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
import privacy from '../../privacy.html?raw';
import headers from '../../_headers?raw';
import eventsApi from '../../functions/api/ppi/events.ts?raw';

type NodeFs = { readFileSync(path: URL, encoding: 'utf8'): string };
type NodeVm = {
  runInNewContext(source: string, context: Record<string, unknown>, options?: { filename?: string }): unknown;
};
type NodeProcess = {
  getBuiltinModule(name: 'fs'): NodeFs;
  getBuiltinModule(name: 'vm'): NodeVm;
};
const nodeProcess = (globalThis as unknown as { process: NodeProcess }).process;
const nodeFs = nodeProcess.getBuiltinModule('fs');
const nodeVm = nodeProcess.getBuiltinModule('vm');
const ppiCss = nodeFs.readFileSync(new URL('../../assets/css/ppi.css', import.meta.url), 'utf8');

type AnchorParts = { attributes: string; content: string };

function requestCtasIn(source: string): AnchorParts[] {
  return [...source.matchAll(/<a\b([^>]*\bdata-request-cta\b[^>]*)>([\s\S]*?)<\/a>/gu)]
    .map((match) => ({ attributes: match[1] ?? '', content: match[2] ?? '' }));
}

function templateContents(id: string): string {
  return page.match(new RegExp(`<template id="${id}">([\\s\\S]*?)<\\/template>`, 'u'))?.[1] ?? '';
}

describe('PPI frontend conversion safeguards', () => {
  it('executes the shipped form bootstrap with first-touch attribution initialized', () => {
    const form = {};
    const stored = new Map<string, string>();
    let configRequests = 0;
    const pendingConfig = new Promise<never>(() => {});
    const location = { search: '', origin: 'https://getautoclarity.com' };

    nodeVm.runInNewContext(script, {
      window: {
        location,
        matchMedia: () => ({ matches: false }),
        setTimeout: () => 0,
        clearTimeout: () => {},
      },
      document: {
        referrer: '',
        getElementById: (id: string) => (id === 'intakeForm' ? form : null),
        querySelectorAll: () => [],
      },
      sessionStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      },
      fetch: () => {
        configRequests += 1;
        return pendingConfig;
      },
      AbortController: undefined,
      URL,
      URLSearchParams,
    }, { filename: 'assets/js/ppi-form.js' });

    expect(configRequests).toBe(1);
    expect(stored.get('ppi-attribution-v1')).toBe('ppi_direct');
  });

  it('does not ship disabled diagnostic-scan or emissions claims in indexable HTML', () => {
    expect(page).not.toMatch(/data-scan|diagnostic scan|emissions readiness/iu);
    expect(page).toContain('Road test &amp; warning-light review');
  });

  it('uses one canonical trailing-slash URL and valid local-service schema', () => {
    expect(page).toContain('<link rel="canonical" href="https://getautoclarity.com/las-vegas-pre-purchase-inspection/" />');
    expect(sitemap).toContain('<loc>https://getautoclarity.com/las-vegas-pre-purchase-inspection/</loc>');
    expect(sitemap).not.toContain('<loc>https://getautoclarity.com/las-vegas-pre-purchase-inspection</loc>');

    const description = page.match(/<meta name="description" content="([^"]+)"/u)?.[1] ?? '';
    expect(description.length).toBeGreaterThan(100);
    expect(description.length).toBeLessThanOrEqual(160);

    const blocks = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gu)];
    expect(blocks).toHaveLength(3);
    const graph = JSON.parse(blocks[0]![1]!) as {
      '@graph': Array<{
        '@type': string;
        url?: string;
        areaServed?: Array<{ name: string }>;
        offers?: Array<{ description: string; priceSpecification: { price: string } }>;
        description?: string;
      }>;
    };
    const service = graph['@graph'].find((node) => node['@type'] === 'Service')!;
    expect(service.url).toBe('https://getautoclarity.com/las-vegas-pre-purchase-inspection/');
    expect(service.areaServed!.map((place) => place.name)).toEqual([
      'Las Vegas',
      'North Las Vegas',
      'Henderson',
      'Boulder City',
    ]);
    expect(service.offers?.map((item) => Number(item.priceSpecification.price))).toEqual([199, 299, 399]);
    expect(service.offers?.every((item) => item.description.includes('Starting price'))).toBe(true);
    expect(service.description).toContain('founder-performed');
  });

  it('keeps every PPI request CTA green, form-bound, and intent-tagged', () => {
    const requestCtas = requestCtasIn(`${page}\n${script}`);
    const intentSteps = requestCtas.map(({ attributes }) => (
      attributes.match(/\bdata-step="([^"]+)"/u)?.[1] ?? ''
    ));

    expect(requestCtas).toHaveLength(5);
    expect(new Set(intentSteps)).toEqual(new Set([
      'request_intent_header',
      'request_intent_hero',
      'request_intent_inspector',
      'request_intent_final',
      'request_intent_sticky',
    ]));

    for (const { attributes, content } of requestCtas) {
      expect(attributes).toContain('href="#request"');
      expect(attributes).toMatch(/\bdata-analytics="ppi_(?:cta|founder_cta)_click"/u);
      expect(attributes).toMatch(/\bdata-step="request_intent_[a-z_]+"/u);
      expect(attributes).not.toMatch(/\bbtn-primary\b/u);
      expect(attributes).toMatch(/\b(?:btn-service|ppi-sticky-primary)\b/u);
      expect(content.trim()).toBe('Request an Inspection');
    }

    const stickyStyle = ppiCss.match(/\.ppi-sticky-primary\s*\{([^}]*)\}/u)?.[1] ?? '';
    expect(stickyStyle).toMatch(/background:\s*linear-gradient\([^;]*var\(--green\)/u);
    expect(stickyStyle).toContain('color: #03140d;');
  });

  it('keeps conditional waitlist and outage shells inert outside their selected runtime state', () => {
    const waitlist = templateContents('waitlistTemplate');
    const fallback = templateContents('fallbackTemplate');
    const renderedPage = page.replace(/<template\b[\s\S]*?<\/template>/gu, '');

    expect(waitlist).toContain('id="waitlistShell"');
    expect(waitlist).toContain('id="waitlistForm"');
    expect(fallback).toContain('id="fallbackShell"');
    expect(renderedPage).not.toContain('id="waitlistShell"');
    expect(renderedPage).not.toContain('id="fallbackShell"');
    expect(renderedPage).toContain('id="intakeShell" hidden');

    const mountState = script.slice(
      script.indexOf('function mountConditionalShell'),
      script.indexOf('function requestJson'),
    );
    expect(mountState).toContain('template.content.firstElementChild.cloneNode(true)');
    expect(mountState).toContain('intakeShell.hidden = true');
    expect(mountState).toContain('waitlistShell = mountConditionalShell(waitlistTemplate, intakeShell)');
    expect(mountState).toContain('fallbackShell = mountConditionalShell(fallbackTemplate, intakeShell)');
    expect(mountState).toContain('heading.focus({ preventScroll: true })');
    expect(mountState).toContain('function removeRuntimeTemplates()');

    const runtimeBranch = script.slice(
      script.indexOf('/* ---------- runtime config ---------- */'),
      script.indexOf('function money'),
    );
    expect(runtimeBranch).toContain('if (!runtimeConfigIsValid(cfg)) throw new Error("invalid runtime config")');
    const liveOrRequestBranch = runtimeBranch.match(
      /if \(cfg\.mode === "waitlist"\) \{\s*activateWaitlistState\(\);\s*\} else \{([\s\S]*?)\n\s*\}/u,
    )?.[1] ?? '';
    expect(liveOrRequestBranch).toContain('applyContact(cfg)');
    expect(liveOrRequestBranch).toContain('setupForm()');
    expect(liveOrRequestBranch).toContain('removeRuntimeTemplates()');
    expect(script).toContain('if (r.status === 409 && r.body && r.body.error && r.body.error.code === "waitlist_mode")');
    expect(script).toContain('activateWaitlistState();');
  });

  it('records the first request-form interaction with accepted start metadata', () => {
    const formStart = script.slice(
      script.indexOf('form.addEventListener("input"'),
      script.indexOf('backBtn.addEventListener', script.indexOf('form.addEventListener("input"')),
    );

    expect(formStart).toContain('if (!formStarted)');
    expect(formStart).toContain('track("ppi_form_started", "request_intake")');
    expect(script.match(/track\("ppi_form_started", "request_intake"\)/gu)).toHaveLength(1);
    expect(eventsApi).toContain("'ppi_form_started'");
  });

  it('discloses replacement-vehicle review and price adjustments consistently', () => {
    expect(page).toContain('one replacement vehicle with no transfer fee');
    expect(page).toContain('re-reviews the replacement vehicle, location, scope and seller access');
    expect(page).toContain('if it is lower, AutoClarity refunds the difference');
    expect(page).toContain('your existing payment transfers with no additional charge');
    expect(page).toContain('A replacement vehicle is re-reviewed and repriced, with any difference collected or refunded');

    expect(portalScript).toContain('A transfer to a replacement vehicle has no transfer fee');
    expect(portalScript).toContain('you pay any increase before the replacement booking is confirmed');
    expect(portalScript).toContain('receive a refund of any decrease');
    expect(portalScript).toContain('carry the same payment forward when the approved totals match');
  });

  it('applies a first-party Content Security Policy to both legal pages', () => {
    for (const route of ['/terms', '/privacy']) {
      expect(headers).toMatch(new RegExp(`${route}\\n\\s+Content-Security-Policy: default-src 'self'`, 'u'));
    }
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
    expect(privacy).toContain('stores a draft containing the fields you entered');
    expect(privacy).toContain("browser tab's session storage");
  });

  it('keeps operator quote defaults aligned with the server suggestion and permits an explicit custom-travel zero', () => {
    expect(adminScript).toContain('suggestedTier === "euro_luxury_performance" ? " selected"');
    expect(adminScript).toContain('suggestedTier === "exotic_collector" ? " selected"');
    expect(adminScript).toContain('dollarsToCents(document.getElementById("qTravel").value, true)');
    expect(adminScript).toContain('travelCents: travelCents !== null ? travelCents : undefined');
  });

  it('preserves allowlisted first-touch attribution from homepage to the PPI form', () => {
    for (const source of [mainScript, script]) {
      expect(source).toContain('ppi-attribution-v1');
      expect(source).toContain('utm_source');
      expect(source).toContain('utm_medium');
      expect(source).not.toContain('params.get("utm_campaign")');
      expect(source).toContain('"ppi_google_business_profile"');
      expect(source).toContain('"ppi_chatgpt_search"');
      expect(source).toContain('"ppi_referral_referral"');
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
    expect(adminScript).toContain('Verified service and revenue scoreboard');
    expect(adminScript).toContain('revenueWindows');
    expect(adminScript).toContain('Recognized net');
    expect(adminScript).toContain('not profit');
    expect(adminScript).toContain('Request cohorts by source');
    expect(adminScript).toContain('App Store clicks');
    expect(adminScript).toContain('— (<20 sample)');
    expect(intakeApi).toContain("surfaceIntakeNotificationFailure(env.DB, requestId, customerEmail, 'request_received'");
    expect(intakeApi).toContain("surfaceIntakeNotificationFailure(env.DB, requestId, ownerEmail, 'owner_new_request'");
  });

  it('keeps response-time and payments-off language truthful by default', () => {
    expect(page).not.toMatch(/normally receive|never later than|hear back the same day/iu);
    expect(page).not.toMatch(/responds? within \d+ hours/iu);
    expect(script).toContain('follow up by email with next steps');
    expect(page).toContain('<div data-payment="off">');
    expect(page).toContain('<div data-payment="on" hidden>');
    expect(page).not.toContain('physical services paid through this website');
    expect(page).toContain('<span data-payment="off">Submitting is free.');
    expect(page).toContain('<span data-payment="on" hidden>After review, select a time, accept the current service agreements, and pay the exact approved quote amount securely through Stripe. Successful payment confirms the appointment.</span>');
    expect(script).toContain('cfg.paymentsEnabled === true');
    expect(page).toContain('<tbody id="travelRows">');
    expect(script).toContain('function applyTravel(cfg)');
    expect(script).not.toContain('function preliminaryTier()');
    expect(script).toContain('AutoClarity confirms the vehicle tier');
    expect(portalScript).not.toMatch(/hear back the same day|never later than|preview environment/iu);
    expect(portalScript).toContain('v.paymentsEnabled');
    expect(portalScript).toContain('function renderAgreementMarkdown(source)');
    expect(portalScript).toContain('renderAgreementMarkdown(doc.bodyMd)');
    expect(portalScript).toContain('Online payment cannot start until the current quote, held appointment, current agreements, and payment service are all ready.');
    expect(portalScript).toContain('No charge has been started, and your appointment is not confirmed.');
    expect(portalAction).toContain("'payments_unavailable'");
    expect(portalAction).toContain('no charge was started');
    expect(portalAction).not.toContain('preview environment');
  });
});
