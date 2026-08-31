import { describe, expect, it, vi } from 'vitest';
import {
  persistNotificationIssue,
  summarizeNotificationIssues,
  type NotificationAuditIssueRow,
  type NotificationMessageIssueRow,
} from '../../functions/lib/notification-issues.ts';

describe('durable notification issues', () => {
  it('uses one stable audit row when a caller enriches the central outbox failure', async () => {
    const writes: unknown[][] = [];
    const db = {
      prepare() {
        let args: unknown[] = [];
        return {
          bind(...values: unknown[]) { args = values; return this; },
          async run() { writes.push(args); return { meta: { changes: 1 } }; },
        };
      },
    } as unknown as D1Database;

    const issueKey = 'outbox:owner_new_request:req_1';
    expect(await persistNotificationIssue(db, {
      actor: 'system:email',
      requestId: 'req_1',
      issueKey,
      kind: 'record_failed',
      sourceAction: 'owner_new_request',
      dedupeKey: 'owner_new_request:req_1',
    })).toBe(true);
    expect(await persistNotificationIssue(db, {
      actor: 'system:intake',
      requestId: 'req_1',
      issueKey,
      kind: 'record_failed',
      sourceAction: 'owner_new_request',
      dedupeKey: 'owner_new_request:req_1',
      error: 'outbox_record_failed',
    })).toBe(true);

    expect(writes).toHaveLength(2);
    expect(writes[0]?.[0]).toBe(writes[1]?.[0]);
    expect(String(writes[1]?.[4])).toContain('owner_new_request');
    expect(String(writes[1]?.[4])).toContain(issueKey);
  });

  it('contains a failure in the fallback itself', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const db = {
      prepare() {
        return {
          bind() { return this; },
          async run() { throw new Error('audit unavailable'); },
        };
      },
    } as unknown as D1Database;

    await expect(persistNotificationIssue(db, {
      actor: 'system:email',
      requestId: 'req_1',
      issueKey: 'outbox:msg_attempt',
      kind: 'record_failed',
      sourceAction: 'request_received',
    })).resolves.toBe(false);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('counts affected requests while deduplicating central and caller audit rows', () => {
    const messages: NotificationMessageIssueRow[] = [
      {
        id: 'msg_1',
        request_id: 'req_1',
        template: 'quote_ready',
        status: 'failed',
        created_at: '2026-08-29T12:00:00.000Z',
        ref: 'PPI-ONE',
      },
      {
        id: 'msg_2',
        request_id: 'req_1',
        template: 'needs_info',
        status: 'recorded',
        created_at: '2026-08-29T12:01:00.000Z',
        ref: 'PPI-ONE',
      },
    ];
    const duplicateDetails = JSON.stringify({
      issueKey: 'outbox:owner_new_request:req_2',
      sourceAction: 'owner_new_request',
    });
    const audits: NotificationAuditIssueRow[] = [
      {
        id: 'audit_central',
        entity_id: 'req_2',
        action: 'notification_record_failed',
        details_json: duplicateDetails,
        created_at: '2026-08-29T12:02:00.000Z',
        ref: 'PPI-TWO',
      },
      {
        id: 'audit_caller',
        entity_id: 'req_2',
        action: 'notification_record_failed',
        details_json: duplicateDetails,
        created_at: '2026-08-29T12:03:00.000Z',
        ref: 'PPI-TWO',
      },
    ];

    const summary = summarizeNotificationIssues(messages, audits);
    expect(summary).toHaveLength(2);
    expect(summary[0]).toMatchObject({
      requestId: 'req_2',
      ref: 'PPI-TWO',
      issueCount: 1,
      kinds: ['email was not queued'],
      sourceActions: ['owner_new_request'],
    });
    expect(summary[1]).toMatchObject({ requestId: 'req_1', issueCount: 2 });
  });
});
