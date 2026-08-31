/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';
import adminScript from '../../assets/js/ppi-admin.js?raw';

describe('admin refund detail history', () => {
  it('renders persisted operations and attempts with actionable terminal-safe guidance', () => {
    const sectionStart = adminScript.indexOf('// ----- refund tracking -----');
    const sectionEnd = adminScript.indexOf('// ----- agreements -----', sectionStart);
    expect(sectionStart).toBeGreaterThan(-1);
    expect(sectionEnd).toBeGreaterThan(sectionStart);

    const section = adminScript.slice(sectionStart, sectionEnd);
    expect(section).toContain('d.refundOperations || []');
    expect(section).toContain('d.refundAttempts || []');
    expect(section).toContain('<h3>Refund operations</h3>');
    expect(section).toContain('<h3>Refund attempts</h3>');
    expect(section).toContain('The operation status below is the current source of truth for the next action.');

    const guidanceStart = adminScript.indexOf('function refundStatusGuidance(status)');
    const guidanceEnd = adminScript.indexOf('/* ================= Overview', guidanceStart);
    const guidance = adminScript.slice(guidanceStart, guidanceEnd);
    for (const status of [
      'pending',
      'requires_action',
      'failed',
      'canceled',
      'reconciliation_required',
      'confirmed',
      'provider_accepted',
    ]) {
      expect(guidance).toContain(`status === "${status}"`);
    }
    expect(guidance).toContain('Do not retry while it is pending.');
    expect(guidance).toContain('Action required in Stripe.');
    expect(guidance).toContain('use Refund… to explicitly retry');
    expect(guidance).toContain('Manual reconciliation required.');
    expect(guidance).toContain('No further action is needed.');
    expect(guidance).toContain('confirmation is still pending. Do not retry.');
  });

  it('escapes every persisted refund value before adding it to admin HTML', () => {
    const sectionStart = adminScript.indexOf('// ----- refund tracking -----');
    const sectionEnd = adminScript.indexOf('// ----- agreements -----', sectionStart);
    const section = adminScript.slice(sectionStart, sectionEnd);

    for (const escapedExpression of [
      'esc(refundOperation.id || "—")',
      'esc(money(Number(refundOperation.requested_amount_cents || 0)))',
      'esc(operationStatus.replace(/_/g, " "))',
      'esc(refundOperation.attempt_count == null ? "—" : refundOperation.attempt_count)',
      'esc(refundOperation.provider_refund_id || "—")',
      'esc(when(refundOperation.updated_at))',
      'esc(refundOperation.last_error)',
      'esc(refundAttempt.operation_id || "—")',
      'esc(refundAttempt.attempt_no == null ? "—" : refundAttempt.attempt_no)',
      'esc(String(refundAttempt.outcome_status || "unknown").replace(/_/g, " "))',
      'esc(refundAttempt.provider_status || "—")',
      'esc(refundAttempt.provider_refund_id || "—")',
      'esc(when(refundAttempt.updated_at))',
      'esc(refundAttempt.error || "—")',
    ]) {
      expect(section).toContain(escapedExpression);
    }

    expect(section).not.toMatch(/\+\s*refund(?:Operation|Attempt)\.[a-z_]+\s*\+/u);
  });
});
