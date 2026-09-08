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
    expect(section).toContain('d.providerRefunds || []');
    expect(section).toContain('<h3>Refund operations</h3>');
    expect(section).toContain('<h3>Refund attempts</h3>');
    expect(section).toContain('<h3>Stripe refund ledger</h3>');
    expect(section).toContain('The payment balance is the sum of entries currently marked succeeded.');
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
      'esc(providerRefund.provider_refund_id || "—")',
      'esc(money(Number(providerRefund.amount_cents || 0)))',
      'esc(String(providerRefund.status || "unknown").replace(/_/g, " "))',
      'esc(providerRefund.operation_id || "external / unmatched")',
      'esc(providerRefund.last_event_id || "—")',
      'esc(new Date(Number(providerRefund.last_event_created) * 1000).toLocaleString())',
      'esc(when(providerRefund.updated_at))',
    ]) {
      expect(section).toContain(escapedExpression);
    }

    expect(section).not.toMatch(/\+\s*(?:refundOperation|refundAttempt|providerRefund)\.[a-z_]+\s*\+/u);
  });

  it('renders the two-axis dispute ledger without unsafe interpolation or reopen controls', () => {
    const sectionStart = adminScript.indexOf('// ----- dispute tracking -----');
    const sectionEnd = adminScript.indexOf('// ----- agreements -----', sectionStart);
    expect(sectionStart).toBeGreaterThan(-1);
    expect(sectionEnd).toBeGreaterThan(sectionStart);

    const section = adminScript.slice(sectionStart, sectionEnd);
    expect(section).toContain('d.paymentDisputes || []');
    expect(section).toContain('<h3>Stripe dispute ledger</h3>');
    expect(section).toContain('status and funds movement are tracked independently');
    expect(section).toContain('never reopens the request, booking, or capacity automatically');
    expect(section).not.toMatch(/button|data-(?:restore|reopen)/u);

    for (const escapedExpression of [
      'esc(dispute.provider_dispute_id || "—")',
      'esc(money(Number(dispute.amount_cents || 0)))',
      'esc(String(dispute.provider_status || "unknown").replace(/_/g, " "))',
      'esc(String(dispute.funds_state || "unknown").replace(/_/g, " "))',
      'esc(dispute.payment_intent || "—")',
      'esc(dispute.provider_charge_id || "—")',
      'esc(dispute.status_event_id || "—")',
      'esc(new Date(Number(dispute.status_event_created) * 1000).toLocaleString())',
      'esc(dispute.funds_event_id || "—")',
      'esc(new Date(Number(dispute.funds_event_created) * 1000).toLocaleString())',
      'esc(when(dispute.updated_at))',
    ]) {
      expect(section).toContain(escapedExpression);
    }
    expect(section).not.toMatch(/\+\s*dispute\.[a-z_]+\s*\+/u);
  });
});
