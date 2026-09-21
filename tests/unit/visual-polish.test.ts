/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';
import homePage from '../../index.html?raw';
import ppiPage from '../../las-vegas-pre-purchase-inspection/index.html?raw';
import adminPage from '../../ppi/admin/index.html?raw';
import portalPage from '../../ppi/portal/index.html?raw';
import mainScript from '../../assets/js/main.js?raw';
import ppiFormScript from '../../assets/js/ppi-form.js?raw';
import ppiAdminScript from '../../assets/js/ppi-admin.js?raw';

type NodeFs = { readFileSync(path: URL, encoding: 'utf8'): string };
type NodeProcess = { getBuiltinModule(name: 'fs'): NodeFs };
const nodeProcess = (globalThis as unknown as { process: NodeProcess }).process;
const nodeFs = nodeProcess.getBuiltinModule('fs');
const siteCss = nodeFs.readFileSync(new URL('../../assets/css/site.css', import.meta.url), 'utf8');
const ppiPath = '/las-vegas-pre-purchase-inspection/';

type AnchorParts = { attributes: string; content: string };

function anchorsIn(source: string): AnchorParts[] {
  return [...source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gu)]
    .map((match) => ({ attributes: match[1] ?? '', content: match[2] ?? '' }));
}

function anchorWithClass(source: string, className: string): AnchorParts {
  const anchor = anchorsIn(source).find(({ attributes }) => {
    const classes = attributes.match(/\bclass="([^"]*)"/u)?.[1]?.split(/\s+/u) ?? [];
    return classes.includes(className);
  });
  expect(anchor, `missing anchor with class ${className}`).toBeDefined();
  return anchor!;
}

function markupText(source: string): string {
  return source.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function openingBodyTag(source: string): string {
  return source.match(/<body\b[^>]*>/u)?.[0] ?? '';
}

function expectScrollCueTargetsToExist(source: string): void {
  const targets = [...source.matchAll(/<a\b[^>]*class="[^"]*\bscroll-cue\b[^"]*"[^>]*href="#([A-Za-z][\w:-]*)"/gu)]
    .map((match) => match[1]);

  expect(targets.length).toBeGreaterThan(0);
  targets.forEach((target) => expect(source).toContain(`id="${target}"`));
}

describe('premium visual and interaction safeguards', () => {
  it('preserves the backend fingerprint and versions the changed visual assets independently', () => {
    const sources = [
      '../../404.html',
      '../../_headers',
      '../../functions/_middleware.ts',
      '../../las-vegas-pre-purchase-inspection/index.html',
      '../../las-vegas-pre-purchase-inspection/sample-report/index.html',
      '../../ppi/admin/index.html',
      '../../ppi/portal/index.html',
      '../../privacy.html',
      '../../terms.html',
    ].map((path) => nodeFs.readFileSync(new URL(path, import.meta.url), 'utf8'));

    for (const page of [homePage, ppiPage]) {
      expect(page).toContain('assets/css/site.css?v=ac-visual-20260913-r1');
      expect(page).toContain('assets/js/main.js?v=ac-visual-20260913-r1');
    }
    for (const page of [adminPage, portalPage]) {
      expect(page).not.toContain('ac-visual-20260913-r1');
    }
    // The booking-flow release rewrote four public assets. Each gets a new
    // fingerprint so a returning visitor cannot run cached JS against new
    // markup; everything untouched keeps its old one so cached copies stay
    // valid. Bump only what actually changed.
    // An asset's fingerprint moves whenever its bytes move. The two scripts
    // changed again after the first release shipped, so they are at r2 while
    // the assets that did not change stay at r1.
    const BOOKING_ASSETS = {
      'assets/css/ppi.css': 'ac-book-20260921-r1',
      'assets/js/ppi-form.js': 'ac-book-20260921-r1',
      'assets/js/ppi-portal.js': 'ac-book-20260921-r2',
      'assets/js/ppi-admin.js': 'ac-book-20260921-r2',
    };
    for (const page of [ppiPage, adminPage, portalPage]) {
      for (const [asset, fingerprint] of Object.entries(BOOKING_ASSETS)) {
        if (!page.includes(asset)) continue;
        expect(page).toContain(`${asset}?v=${fingerprint}`);
        expect(page).not.toContain(`${asset}?v=ac-ai-20260911-r1`);
      }
    }
    // Assets this release did not touch must NOT be re-fingerprinted.
    for (const untouched of ['assets/js/ppi-report-view.js', 'assets/css/ppi-report.css']) {
      for (const page of [adminPage, portalPage]) {
        if (!page.includes(untouched)) continue;
        expect(page).toContain(`${untouched}?v=ac-ai-20260911-r1`);
      }
    }
    // Every reference still carries a known, current fingerprint — no source
    // may invent a third scheme or leave an asset unversioned.
    const KNOWN = new Set(['ac-ai-20260911-r1', 'ac-book-20260921-r1', 'ac-book-20260921-r2']);
    for (const source of sources) {
      const fingerprints = source.match(/ac-(?:prod|ai|book)-\d{8}-r\d+/gu) ?? [];
      expect(fingerprints.length).toBeGreaterThan(0);
      for (const fingerprint of fingerprints) expect(KNOWN).toContain(fingerprint);
    }
    // The backend build fingerprint itself is unchanged: this release ships no
    // new public facts, so the discovery documents must not claim a new build.
    const [, headers, middleware] = sources;
    expect(headers).toContain('X-AutoClarity-Build: ac-ai-20260911-r1');
    expect(middleware).toContain('ac-ai-20260911-r1');
  });

  it('keeps the homepage desktop navigation focused and ordered', () => {
    const desktopNav = homePage.match(/<nav class="nav-links" aria-label="Primary">([\s\S]*?)<\/nav>/u)?.[1] ?? '';
    const labels = anchorsIn(desktopNav).map(({ content }) => markupText(content));

    expect(labels).toEqual(['How it works', 'Your report', 'Support']);
    expect(desktopNav).not.toContain('Las Vegas PPI');
  });

  it('keeps the canonical service CTA visible with responsive header labels and a full menu label', () => {
    for (const className of ['nav-service-cta', 'nav-mobile-service']) {
      const anchor = anchorWithClass(homePage, className);
      expect(anchor.attributes).toContain(`href="${ppiPath}"`);
      expect(anchor.attributes).toContain('aria-label="Las Vegas Pre-Purchase Inspection"');
      expect(anchor.attributes).not.toContain('#');
      expect(anchor.content).toMatch(/<span class="status-dot" aria-hidden="true"><\/span>/u);
      expect(anchor.attributes).toContain('data-analytics="ppi_cta_click"');
    }

    const headerCta = anchorWithClass(homePage, 'nav-service-cta');
    expect(headerCta.content).toContain('<span class="nav-service-label-full">Las Vegas Pre-Purchase Inspection</span>');
    expect(headerCta.content).toContain('<span class="nav-service-label-short" aria-hidden="true">Las Vegas PPI</span>');
    expect(markupText(anchorWithClass(homePage, 'nav-mobile-service').content)).toBe('Las Vegas Pre-Purchase Inspection');

    const mobileMenu = homePage.match(/<details class="nav-mobile-menu">([\s\S]*?)<\/details>/u)?.[1] ?? '';
    const mobileLinks = mobileMenu.match(/<nav class="nav-mobile-links"[^>]*>([\s\S]*?)<\/nav>/u)?.[1] ?? '';
    expect(mobileMenu).toContain('<summary role="button" aria-label="Open navigation" aria-controls="home-mobile-nav">');
    expect(mainScript).toContain('mobileMenuSummary.setAttribute("aria-expanded", open ? "true" : "false")');
    expect(mainScript).toContain('if (event.key === "Escape" && mobileMenu.open)');
    expect(anchorsIn(mobileLinks).map(({ content }) => markupText(content))).toEqual([
      'How it works',
      'Your report',
      'Support',
    ]);
    expect(mobileMenu).toContain('data-step="service_discovery_home_menu"');
    const mobileNavStyles = siteCss.match(/@media \(max-width: 1000px\)\s*\{([\s\S]*?)\n\}/u)?.[1] ?? '';
    expect(mobileNavStyles).toMatch(/\.home-nav \.nav-mobile-menu\s*\{\s*display:\s*block;\s*\}/u);
    expect(mobileNavStyles).not.toMatch(/nav-service-cta[^}]*display:\s*none/u);
    expect(siteCss).toMatch(/\.nav-service-label-short\s*\{\s*display:\s*none;\s*\}/u);
    expect(siteCss).toMatch(
      /@media \(max-width: 780px\)[\s\S]*?\.home-nav \.nav-service-label-full\s*\{\s*display:\s*none;\s*\}[\s\S]*?\.home-nav \.nav-service-label-short\s*\{\s*display:\s*inline;\s*\}/u,
    );
  });

  it('gives both navigation service markers a scoped bright-green treatment', () => {
    const scopedDot = siteCss.match(
      /\.nav-service-cta \.status-dot,\s*\.nav-mobile-service \.status-dot\s*\{([^}]*)\}/u,
    )?.[1] ?? '';

    expect(scopedDot).toContain('background: #dcff72;');
    expect(scopedDot).toContain('border: 1px solid rgba(3, 20, 13, 0.62);');
    expect(scopedDot).toMatch(/box-shadow:[\s\S]*rgba\(220, 255, 114, 0\.72\);/u);
  });

  it('limits the full-page ambient treatment to public marketing pages', () => {
    expect(openingBodyTag(homePage)).toContain('data-fx-full');
    expect(openingBodyTag(ppiPage)).toContain('data-fx-full');
    expect(openingBodyTag(adminPage)).not.toContain('data-fx-full');
    expect(openingBodyTag(portalPage)).not.toContain('data-fx-full');
  });

  it('keeps the founder story and PPI bridge ahead of the app walkthrough', () => {
    const founderStart = homePage.indexOf('id="mechanic"');
    const bridgeStart = homePage.indexOf('<aside class="hero-ppi-card ppi-bridge reveal"');
    const howItWorksStart = homePage.indexOf('id="how-it-works"');
    const bridgeEnd = homePage.indexOf('</aside>', bridgeStart);
    const bridge = homePage.slice(bridgeStart, bridgeEnd);

    expect(founderStart).toBeGreaterThan(-1);
    expect(bridgeStart).toBeGreaterThan(founderStart);
    expect(howItWorksStart).toBeGreaterThan(bridgeStart);
    expect(bridge).toContain('id="ppi"');
    expect(bridge).toContain('aria-labelledby="ppi-home-title"');
    expect(bridge).toContain('id="ppi-home-title"');
    expect(bridge).toContain('Las Vegas · Mobile Pre-Purchase Inspections');
    expect(bridge).toContain('data-analytics="ppi_cta_click"');
    expect(bridge).toContain('data-step="service_discovery_home_bridge"');
    expect(bridge).toContain('data-step="service_discovery_home_scope"');
    expect(anchorsIn(bridge).map(({ attributes }) => attributes.match(/\bhref="([^"]+)"/u)?.[1])).toEqual([
      ppiPath,
      ppiPath,
    ]);
    expect(bridge).not.toMatch(/href="[^"]*#(?:request|whats-inspected)"/u);
  });

  it('states the PPI service explicitly and keeps every scroll cue target valid', () => {
    expect(ppiPage).toContain('Las Vegas · Mobile Pre-Purchase Inspections');
    expectScrollCueTargetsToExist(homePage);
    expectScrollCueTargetsToExist(ppiPage);
  });

  it('keeps every PPI tier labeled as starting at when runtime pricing changes', () => {
    const prefixes = [...ppiPage.matchAll(/<span class="price-prefix"([^>]*)>([^<]+)<\/span>/gu)];

    expect(prefixes).toHaveLength(3);
    for (const [, attributes, label] of prefixes) {
      expect(attributes).not.toContain('data-prefix');
      expect(label).toBe('Starting at');
    }

    expect(ppiPage).toContain('data-launch="standard"');
    expect(ppiPage).toContain('data-launch="euro_luxury_performance"');
  });

  it('hides non-editable carets while restoring insertion carets for editable text', () => {
    expect(siteCss).toMatch(/body\s*\{[^}]*caret-color:\s*transparent;/su);
    expect(siteCss).toMatch(
      /input,\s*textarea,\s*\[contenteditable\]:not\(\[contenteditable="false"\]\)\s*\{[^}]*caret-color:\s*auto;/su,
    );
  });

  it('keeps ambient FX decorative, passive, motion-gated, and calm around forms', () => {
    const fxStart = mainScript.indexOf('/* ---------- Page-wide electric-blue ambience ----------');
    const fxEnd = mainScript.indexOf('/* ---------- Homepage conversion analytics', fxStart);
    const fxBlock = mainScript.slice(fxStart, fxEnd);

    expect(fxStart).toBeGreaterThan(-1);
    expect(fxEnd).toBeGreaterThan(fxStart);
    expect(fxBlock).toContain('document.body.hasAttribute("data-fx-full")');
    expect(fxBlock).toContain('!reducedMotion.matches');
    expect(fxBlock.match(/setAttribute\("aria-hidden", "true"\)/gu)).toHaveLength(2);
    expect(siteCss).toMatch(/\.cursor-glow\s*\{[^}]*pointer-events:\s*none;/su);
    expect(siteCss).toMatch(/\.neon-grid\s*\{[^}]*pointer-events:\s*none;/su);
    expect(fxBlock).toContain('requestAnimationFrame(fxTick)');

    for (const listener of ['pointermove', 'pointerenter', 'touchstart', 'touchmove', 'touchend', 'touchcancel']) {
      expect(fxBlock).toMatch(new RegExp(`addEventListener\\("${listener}"[^;]+\\{ passive: true \\}\\)`, 'u'));
    }

    expect(fxBlock).toContain('formFocused');
    expect(fxBlock).toContain('target.closest("[data-fx-calm]")');
    expect(fxBlock).toContain('document.querySelectorAll("[data-fx-calm]")');
    expect(fxBlock).toContain('IntersectionObserver');
    expect(fxBlock).toContain('removeEventListener("pointermove", desktopPointerMove)');
    expect(fxBlock).toContain('calmObserver.disconnect()');
    expect(fxBlock).not.toContain('preventDefault');
  });

  it('uses smooth scrolling only when reduced motion is not requested', () => {
    expect(siteCss).toMatch(/html\s*\{[^}]*scroll-behavior:\s*smooth;/su);
    expect(siteCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?html\s*\{\s*scroll-behavior:\s*auto;\s*\}/u);
    expect(mainScript).toContain('behavior: reducedMotion.matches ? "auto" : "smooth"');
    expect(ppiFormScript.match(/behavior: reducedMotion\.matches \? "auto" : "smooth"/gu)).toHaveLength(3);
    expect(ppiAdminScript).toContain('behavior: reducedMotion.matches ? "auto" : "smooth"');
  });
});
