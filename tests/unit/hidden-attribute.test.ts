import { describe, expect, it } from 'vitest';
import ppiPage from '../../las-vegas-pre-purchase-inspection/index.html?raw';

type NodeFs = { readFileSync(path: URL, encoding: 'utf8'): string };
type NodeProcess = { getBuiltinModule(name: 'fs'): NodeFs };
const nodeProcess = (globalThis as unknown as { process: NodeProcess }).process;
const siteCss = nodeProcess.getBuiltinModule('fs').readFileSync(
  new URL('../../assets/css/site.css', import.meta.url),
  'utf8',
);

describe('native hidden-state safeguards', () => {
  it('keeps hidden elements out of layout even when a component sets display', () => {
    expect(siteCss).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/u);
  });

  it('ships non-current form controls and steps hidden', () => {
    expect(ppiPage).toMatch(/id="backBtn"[^>]*\shidden(?:\s|>)/u);
    expect(ppiPage).toMatch(/id="submitBtn"[^>]*\shidden(?:\s|>)/u);
    expect(ppiPage).toMatch(/data-step="2"[^>]*\shidden(?:\s|>)/u);
    expect(ppiPage).toMatch(/data-step="3"[^>]*\shidden(?:\s|>)/u);
    expect(ppiPage).toMatch(/data-step="4"[^>]*\shidden(?:\s|>)/u);
  });

  it('never falls back to placing intake details in the page URL', () => {
    expect(ppiPage).toMatch(
      /<form\s+id="intakeForm"\s+method="post"\s+action="\/api\/ppi\/requests"\s+novalidate>/u,
    );
  });
});
