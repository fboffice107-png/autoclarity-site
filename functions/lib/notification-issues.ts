import { nowIso, sha256Hex } from './util.ts';

export type DurableNotificationIssueKind = 'record_failed' | 'link_failed';

export interface PersistNotificationIssueInput {
  actor: string;
  requestId: string | null;
  issueKey: string;
  kind: DurableNotificationIssueKind;
  sourceAction: string;
  template?: string;
  dedupeKey?: string;
  error?: string;
}

export interface NotificationMessageIssueRow {
  id: string;
  request_id: string | null;
  template: string | null;
  status: string;
  created_at: string;
  ref: string | null;
}

export interface NotificationAuditIssueRow {
  id: string;
  entity_id: string | null;
  action: string;
  details_json: string | null;
  created_at: string;
  ref: string | null;
}

export interface NotificationIssueRequest {
  requestId: string;
  ref: string;
  latestAt: string;
  issueCount: number;
  kinds: string[];
  sourceActions: string[];
}

/**
 * Keep the fallback independent of lead/message persistence. If even the audit
 * table is unavailable, structured logs remain the last-resort signal.
 */
export async function persistNotificationIssue(
  db: D1Database,
  input: PersistNotificationIssueInput,
): Promise<boolean> {
  try {
    const auditId = `al_ni_${(await sha256Hex(input.issueKey)).slice(0, 40)}`;
    const action = input.kind === 'link_failed' ? 'notification_link_failed' : 'notification_record_failed';
    const details = JSON.stringify({
      issueKey: input.issueKey,
      sourceAction: input.sourceAction,
      template: input.template ?? null,
      dedupeKey: input.dedupeKey ?? null,
      error: input.error?.slice(0, 240) ?? null,
    }).slice(0, 4000);
    await db
      .prepare(
        `INSERT INTO admin_audit_log (id, actor, action, entity, entity_id, details_json, created_at)
         VALUES (?, ?, ?, 'ppi_request', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           actor = excluded.actor,
           action = excluded.action,
           entity = excluded.entity,
           entity_id = excluded.entity_id,
           details_json = excluded.details_json,
           created_at = excluded.created_at`,
      )
      .bind(auditId, input.actor, action, input.requestId, details, nowIso())
      .run();
    return true;
  } catch (e) {
    console.error(JSON.stringify({
      event: 'notification_issue_persist_failed',
      requestId: input.requestId,
      sourceAction: input.sourceAction,
      issueKey: input.issueKey.slice(0, 160),
      error: String(e).slice(0, 240),
    }));
    return false;
  }
}

/** Record that a failed/stuck stored row was superseded by a confirmed send. */
export async function resolveStoredNotificationIssue(
  db: D1Database,
  messageId: string,
  deliveredMessageId: string,
): Promise<void> {
  try {
    const id = `al_nr_${(await sha256Hex(`message:${messageId}`)).slice(0, 40)}`;
    await db
      .prepare(
        `INSERT INTO admin_audit_log (id, actor, action, entity, entity_id, details_json, created_at)
         VALUES (?, 'system:email', 'notification_issue_resolved', 'message', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET details_json = excluded.details_json, created_at = excluded.created_at`,
      )
      .bind(id, messageId, JSON.stringify({ deliveredMessageId }).slice(0, 4000), nowIso())
      .run();
  } catch (e) {
    console.error(JSON.stringify({
      event: 'notification_issue_resolution_failed',
      messageId,
      deliveredMessageId,
      error: String(e).slice(0, 240),
    }));
  }
}

/** A later successfully queued notification clears earlier action/link alerts. */
export async function resolveNotificationActionIssues(
  db: D1Database,
  actor: string,
  requestId: string,
  sourceAction: string,
): Promise<void> {
  try {
    const id = `al_nr_${(await sha256Hex(`action:${requestId}:${sourceAction}`)).slice(0, 40)}`;
    await db
      .prepare(
        `INSERT INTO admin_audit_log (id, actor, action, entity, entity_id, details_json, created_at)
         VALUES (?, ?, 'notification_issue_resolved', 'ppi_request', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET actor = excluded.actor, details_json = excluded.details_json,
           created_at = excluded.created_at`,
      )
      .bind(id, actor, requestId, JSON.stringify({ sourceAction }).slice(0, 4000), nowIso())
      .run();
  } catch (e) {
    console.error(JSON.stringify({
      event: 'notification_action_resolution_failed',
      requestId,
      sourceAction,
      error: String(e).slice(0, 240),
    }));
  }
}

function auditDetails(row: NotificationAuditIssueRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.details_json ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * The dashboard count is affected requests, not raw log rows. That keeps one
 * failed attempt from appearing twice when both the central fallback and its
 * caller add context.
 */
export function summarizeNotificationIssues(
  messages: NotificationMessageIssueRow[],
  audits: NotificationAuditIssueRow[],
): NotificationIssueRequest[] {
  const grouped = new Map<string, {
    requestId: string;
    ref: string;
    latestAt: string;
    issueKeys: Set<string>;
    kinds: Set<string>;
    sourceActions: Set<string>;
  }>();

  const groupFor = (requestId: string, ref: string | null, createdAt: string) => {
    let group = grouped.get(requestId);
    if (!group) {
      group = {
        requestId,
        ref: ref || requestId,
        latestAt: createdAt,
        issueKeys: new Set<string>(),
        kinds: new Set<string>(),
        sourceActions: new Set<string>(),
      };
      grouped.set(requestId, group);
    }
    if (createdAt > group.latestAt) group.latestAt = createdAt;
    return group;
  };

  for (const message of messages) {
    if (!message.request_id) continue;
    const group = groupFor(message.request_id, message.ref, message.created_at);
    group.issueKeys.add(`message:${message.id}`);
    group.kinds.add(message.status === 'recorded' ? 'delivery pending' : 'delivery failed');
    group.sourceActions.add(message.template || 'email');
  }

  for (const audit of audits) {
    if (!audit.entity_id) continue;
    const details = auditDetails(audit);
    const sourceAction = typeof details['sourceAction'] === 'string' ? details['sourceAction'] : audit.action;
    const issueKey = typeof details['issueKey'] === 'string'
      ? details['issueKey']
      : `${audit.action}:${audit.entity_id}:${sourceAction}`;
    const group = groupFor(audit.entity_id, audit.ref, audit.created_at);
    group.issueKeys.add(`audit:${issueKey}`);
    group.kinds.add(audit.action === 'notification_link_failed' ? 'secure link failed' : 'email was not queued');
    group.sourceActions.add(sourceAction);
  }

  return [...grouped.values()]
    .map((group) => ({
      requestId: group.requestId,
      ref: group.ref,
      latestAt: group.latestAt,
      issueCount: group.issueKeys.size,
      kinds: [...group.kinds].sort(),
      sourceActions: [...group.sourceActions].sort(),
    }))
    .sort((a, b) => b.latestAt.localeCompare(a.latestAt));
}
