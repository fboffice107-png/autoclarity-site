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
    expect(bridge).toContain('href="/las-vegas-pre-purchase-inspection/#request"');
    expect(bridge).toContain('data-analytics="ppi_cta_click"');
    expect(bridge).toContain('data-step="home_bridge"');
    expect(bridge).toContain('href="/las-vegas-pre-purchase-inspection/#whats-inspected"');
  });

  it('states the PPI service explicitly and keeps every scroll cue target valid', () => {
    expect(ppiPage).toContain('Las Vegas · Mobile pre-purchase inspections');
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
