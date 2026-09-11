// Report authoring reuses the existing normalized inspection schema. Every
// edit is a compare-and-swap D1 batch; a request-local random write token gates
// all dependent statements so a losing autosave cannot overwrite a winner.
import type { Env } from './types.ts';
import { newId, nowIso, sha256Hex } from './util.ts';
import { loadPublishedReportVersion, projectCustomerReportPayload, type CustomerReportPayload } from './published-report.ts';
import { getConfig } from './config.ts';
import { issueMagicLink, portalUrl } from './magic.ts';
import { queueTemplate, retryStoredEmail, type StoredEmailMessage, type EmailResult } from './email.ts';

export const REPORT_TEMPLATE = [
  ['identification', 'Vehicle identification'], ['exterior', 'Exterior / body'],
  ['glass_lighting', 'Glass / lighting'], ['tires', 'Wheels / tires'], ['brakes', 'Brakes'],
  ['steering', 'Steering'], ['suspension', 'Suspension'], ['engine', 'Engine'],
  ['fluids', 'Engine fluids'], ['leaks', 'Leaks'], ['cooling', 'Cooling system'],
  ['belts_hoses', 'Belts / hoses'], ['battery', 'Battery / charging'], ['electrical', 'Electrical'],
  ['warning_indicators', 'Warning indicators'], ['scan', 'Authorized diagnostic scan'],
  ['drivetrain', 'Transmission / drivetrain'], ['exhaust', 'Exhaust'], ['hvac', 'HVAC'],
  ['interior', 'Interior'], ['restraints', 'Restraints / basic safety equipment'],
  ['road_test', 'Authorized road-test observations'], ['underbody', 'Accessible underbody'],
  ['limitations', 'Seller / access limitations'],
].map(([key, title]) => ({ key: key!, title: title! }));

const RESULTS = ['', 'pass', 'attention', 'fail', 'not_inspected', 'not_accessible', 'not_applicable'] as const;
const REASONS = ['', 'not_accessible', 'unsafe_to_test', 'seller_declined', 'equipment_unavailable', 'not_supported', 'not_applicable'] as const;
const VERDICTS = ['', 'proceed', 'negotiate_repair_first', 'do_not_proceed'] as const;
const PRIORITIES = ['', 'immediate', 'soon', 'monitor', 'informational'] as const;
export interface DraftItem {
  key: string; label: string; result: typeof RESULTS[number]; notInspectedReason: typeof REASONS[number];
  customerNote: string; internalNotes: string; priority: typeof PRIORITIES[number];
  safetyCritical: boolean; negotiationItem: boolean;
  measurement?: { value?: string; unit?: string };
  costLowCents?: number; costHighCents?: number;
}
export interface DraftSection {
  key: string; title: string; performed: 'performed' | 'partial' | 'not_performed';
  notPerformedReason: typeof REASONS[number]; summary: string; items: DraftItem[];
}
export interface ReportDraft {
  inspectorName: string; inspectedAt: string; odometerMiles: number | null; score: number | null;
  verdict: typeof VERDICTS[number]; executiveSummary: string; positiveFindings: string;
  negotiationSummary: string; limitationsNotes: string; sections: DraftSection[];
}
export interface ReportRow {
  id: string; request_id: string; customer_id: string; vehicle_id: string; state: string;
  inspector_name: string | null; inspected_at: string | null; odometer_miles: number | null;
  score: number | null; verdict: string | null; executive_summary: string | null;
  positive_findings: string | null; negotiation_summary: string | null; limitations_notes: string | null;
  autosave_seq: number; published_version_id: string | null; published_at: string | null;
  reviewed_at: string | null; reviewed_by: string | null; started_by: string; created_at: string;
  amendment_reason: string | null;
  plate: string | null; plate_state: string | null; vin_check: string; title_disclosure_notes: string | null;
}
export interface ReportJob {
  id: string; ref: string; status: string; customer_id: string; vehicle_id: string;
  email: string; year: number | null; make: string; model: string; vin: string | null;
  booking_id: string | null; quote_id: string | null; booking_status: string | null;
  vehicle_trim: string | null; title_status: string | null;
}
export interface ReportPhoto {
  id: string; item_key: string | null; caption: string | null; object_key: string;
  content_type: string; size_bytes: number; sha256: string | null;
  referenced?: number;
}
export class ReportError extends Error {
  constructor(readonly code: string, message: string, readonly status = 422) { super(message); }
}
const conflict = () => new ReportError('conflict', 'This report changed in another window. Reload before editing again; your unsaved text has not been applied.', 409);
const obj = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ReportError('validation', 'Report fields must be objects.');
  return v as Record<string, unknown>;
};
function text(v: unknown, max: number): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' || v.length > max) throw new ReportError('validation', 'A report text field is invalid or too long.');
  return v.trim();
}
function option<T extends string>(v: unknown, choices: readonly T[]): T {
  const value = v === null || v === undefined ? '' : v;
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new ReportError('validation', 'An inspection state is not supported.');
  return value as T;
}
function key(v: unknown): string {
  if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(v)) throw new ReportError('validation', 'An inspection item key is invalid.');
  return v;
}
export function defaultReportDraft(): ReportDraft {
  return {
    inspectorName: '', inspectedAt: '', odometerMiles: null, score: null, verdict: '',
    executiveSummary: '', positiveFindings: '', negotiationSummary: '', limitationsNotes: '',
    sections: REPORT_TEMPLATE.map(({ key, title }) => ({
      key, title, performed: 'not_performed', notPerformedReason: '', summary: '',
      items: [{ key: `${key}_observations`, label: title, result: '', notInspectedReason: '',
        customerNote: '', internalNotes: '', priority: '', safetyCritical: false, negotiationItem: false }],
    })),
  };
}

/** Unknown fields are discarded. No heuristic verdict or inferred inspection. */
export function validateReportDraft(value: unknown, ready = false): ReportDraft {
  const raw = obj(value);
  if (!Array.isArray(raw.sections) || raw.sections.length < 1 || raw.sections.length > 50) throw new ReportError('validation', 'Include 1–50 inspection categories.');
  const sectionsSeen = new Set<string>();
  const itemsSeen = new Set<string>();
  const sections = raw.sections.map((s): DraftSection => {
    const section = obj(s);
    const sectionKey = key(section.key);
    if (sectionsSeen.has(sectionKey)) throw new ReportError('validation', 'Category keys must be unique.');
    sectionsSeen.add(sectionKey);
    if (!Array.isArray(section.items) || section.items.length < 1 || section.items.length > 100) throw new ReportError('validation', 'Each category needs 1–100 findings.');
    const performed = option(section.performed, ['performed', 'partial', 'not_performed'] as const);
    const notPerformedReason = option(section.notPerformedReason, REASONS);
    const items = section.items.map((v): DraftItem => {
      const item = obj(v); const itemKey = key(item.key);
      if (itemsSeen.has(itemKey) || itemsSeen.size >= 300) throw new ReportError('validation', 'Finding keys must be unique; maximum 300 findings.');
      itemsSeen.add(itemKey);
      const result = option(item.result, RESULTS);
      const reason = result === 'not_accessible' ? 'not_accessible' : option(item.notInspectedReason, REASONS);
      const label = text(item.label, 300);
      const customerNote = text(item.customerNote, 8000);
      if (!label) throw new ReportError('validation', 'Each finding needs a label.');
      if (ready && (!result || (result === 'not_inspected' && (!reason || reason === 'not_applicable')))) {
        throw new ReportError('review_incomplete', `Record an explicit result and any not-inspected reason for “${label}”.`);
      }
      if (ready && (result === 'attention' || result === 'fail') && !customerNote) throw new ReportError('review_incomplete', `Explain the concern for “${label}”.`);
      if (ready && performed === 'not_performed' && ['pass','attention','fail'].includes(result)) throw new ReportError('review_incomplete', 'A category marked not performed cannot contain inspected findings.');
      const measurement=item.measurement ? obj(item.measurement) : null;
      const money=(v:unknown):number|undefined=>{if(v===undefined||v===null)return undefined;if(!Number.isSafeInteger(v)||Number(v)<0||Number(v)>100000000)throw new ReportError('validation','Invalid estimated cost.');return Number(v);};
      const low=money(item.costLowCents),high=money(item.costHighCents);
      if(low!==undefined&&high!==undefined&&low>high)throw new ReportError('validation','Estimated cost range is inverted.');
      return { key: itemKey, label, result, notInspectedReason: reason, customerNote,
        internalNotes: text(item.internalNotes, 8000), priority: option(item.priority, PRIORITIES),
        safetyCritical: item.safetyCritical === true, negotiationItem: item.negotiationItem === true,
        ...(measurement?{measurement:{value:text(measurement.value,200),unit:text(measurement.unit,100)}}:{}),
        ...(low!==undefined?{costLowCents:low}:{}),...(high!==undefined?{costHighCents:high}:{}) };
    });
    const title = text(section.title, 200);
    if (!title) throw new ReportError('validation', 'Each category needs a title.');
    if (ready && performed !== 'performed' && !notPerformedReason) throw new ReportError('review_incomplete', `Explain the access or inspection limitation for “${title}”.`);
    if (ready && performed === 'performed' && items.some(i => ['not_inspected','not_accessible'].includes(i.result))) throw new ReportError('review_incomplete', `Mark “${title}” partially or not performed to reflect uninspected findings.`);
    return { key: sectionKey, title, performed, notPerformedReason, summary: text(section.summary, 8000), items };
  });
  const odometer = raw.odometerMiles === '' || raw.odometerMiles === undefined ? null : raw.odometerMiles;
  const score = raw.score === '' || raw.score === undefined ? null : raw.score;
  if (odometer !== null && (!Number.isSafeInteger(odometer) || Number(odometer) < 0 || Number(odometer) > 10_000_000)) throw new ReportError('validation', 'Odometer must be a non-negative whole number.');
  if (score !== null && (typeof score !== 'number' || !Number.isFinite(score) || score < 1 || score > 10)) throw new ReportError('validation', 'The inspector score must be from 1 through 10.');
  const inspectedAt = text(raw.inspectedAt, 40);
  if (inspectedAt && Number.isNaN(Date.parse(inspectedAt))) throw new ReportError('validation', 'Inspection date is invalid.');
  const draft: ReportDraft = {
    inspectorName: text(raw.inspectorName, 200), inspectedAt,
    odometerMiles: odometer as number | null, score: score as number | null,
    verdict: option(raw.verdict, VERDICTS), executiveSummary: text(raw.executiveSummary, 12000),
    positiveFindings: text(raw.positiveFindings, 12000), negotiationSummary: text(raw.negotiationSummary, 12000),
    limitationsNotes: text(raw.limitationsNotes, 12000), sections,
  };
  if (ready && (!draft.inspectorName || !inspectedAt || !draft.verdict || !draft.executiveSummary || score === null || !draft.limitationsNotes)) {
    throw new ReportError('review_incomplete', 'Review requires inspector name, inspection date, human-selected score and buyer guidance, executive summary, and limitations.');
  }
  return draft;
}

export async function loadReportJob(db: D1Database, requestId: string): Promise<ReportJob> {
  const job = await db.prepare(`SELECT r.id,r.ref,r.status,r.customer_id,r.vehicle_id,c.email,v.year,v.make,v.model,v.vin,v.trim AS vehicle_trim,v.title_status,
    b.id AS booking_id,b.quote_id,b.status AS booking_status FROM ppi_requests r
    JOIN customers c ON c.id=r.customer_id JOIN vehicles v ON v.id=r.vehicle_id
    LEFT JOIN bookings b ON b.request_id=r.id WHERE r.id=? AND r.deleted_at IS NULL`).bind(requestId).first<ReportJob>();
  if (!job) throw new ReportError('not_found', 'Request not found.', 404);
  return job;
}
export async function loadReportRow(db: D1Database, requestId: string): Promise<ReportRow | null> {
  return db.prepare('SELECT * FROM inspection_reports WHERE request_id=?').bind(requestId).first<ReportRow>();
}
export async function loadReportPhotos(db: D1Database, reportId: string): Promise<ReportPhoto[]> {
  return (await db.prepare(`SELECT id,item_key,caption,object_key,content_type,size_bytes,sha256,
    EXISTS(SELECT 1 FROM report_version_photos vp WHERE vp.photo_id=report_photos.id) AS referenced
    FROM report_photos WHERE report_id=? AND deleted_at IS NULL ORDER BY sort,created_at,id`).bind(reportId).all<ReportPhoto>()).results;
}
export async function loadReportDraft(db: D1Database, row: ReportRow): Promise<ReportDraft> {
  const [sections, items, selected] = await Promise.all([
    db.prepare('SELECT * FROM report_sections WHERE report_id=? ORDER BY rowid').bind(row.id).all<Record<string, unknown>>(),
    db.prepare('SELECT * FROM report_items WHERE report_id=? ORDER BY rowid').bind(row.id).all<Record<string, unknown>>(),
    db.prepare('SELECT payload_json,payload_sha256 FROM report_versions WHERE id=? AND report_id=? AND request_id=?').bind(row.published_version_id,row.id,row.request_id).first<{payload_json:string;payload_sha256:string}>(),
  ]);
  const legacyTitles=new Map<string,string>(),legacyLabels=new Map<string,string>();
  const legacySections=new Map<string,Record<string,unknown>>();let legacyRoot:Record<string,unknown>={};
  if(selected && selected.payload_json.length<1048576 && await sha256Hex(selected.payload_json)===selected.payload_sha256){
    try{const snapshot:unknown=JSON.parse(selected.payload_json);const raw=obj(snapshot);legacyRoot=raw;
      if(Array.isArray(raw.sections))for(const rawSection of raw.sections){const s=obj(rawSection);
        if(typeof s.key==='string')legacySections.set(s.key,s);
        if(typeof s.key==='string'&&typeof s.title==='string')legacyTitles.set(s.key,s.title);
        if(Array.isArray(s.items))for(const rawItem of s.items){const i=obj(rawItem);if(typeof i.key==='string'&&typeof i.label==='string')legacyLabels.set(i.key,i.label);}
      }
    }catch{/* A malformed historical snapshot never authorizes draft changes. */}
  }
  // The historical production writer stored 104 items but no report_sections
  // rows. Reconstruct category scaffolding from that exact selected snapshot,
  // and always carry the existing items; never substitute a fresh checklist.
  const sectionRows=[...sections.results];const knownSections=new Set(sectionRows.map(s=>String(s.section_key)));
  for(const i of items.results){const sectionKey=String(i.section_key);if(knownSections.has(sectionKey))continue;
    knownSections.add(sectionKey);const snapshot=legacySections.get(sectionKey);
    sectionRows.push({section_key:sectionKey,title:snapshot?.title||sectionKey,performed:snapshot?.performed||'not_performed',
      not_performed_reason:snapshot?.notPerformedReason||null,summary_note:snapshot?.summary||''});
  }
  const legacyOverall=legacyRoot.overall&&typeof legacyRoot.overall==='object'?obj(legacyRoot.overall):{};
  const legacyLimitations=legacyRoot.limitations&&typeof legacyRoot.limitations==='object'?obj(legacyRoot.limitations):{};
  const legacyText=(v:unknown)=>typeof v==='string'?v:'';
  return {
    inspectorName: row.inspector_name ?? legacyText(legacyRoot.inspector), inspectedAt: row.inspected_at ?? legacyText(legacyRoot.inspectedAt), odometerMiles: row.odometer_miles,
    score: row.score ?? (typeof legacyOverall.score==='number'?legacyOverall.score:null), verdict: option(row.verdict ?? legacyOverall.verdict, VERDICTS), executiveSummary: row.executive_summary ?? legacyText(legacyOverall.executiveSummary),
    positiveFindings: row.positive_findings ?? legacyText(legacyOverall.positiveFindings), negotiationSummary: row.negotiation_summary ?? legacyText(legacyOverall.negotiationSummary), limitationsNotes: row.limitations_notes ?? legacyText(legacyLimitations.additional),
    sections: sectionRows.length ? sectionRows.map(s => ({
      key: String(s.section_key), title: String(s.title || legacyTitles.get(String(s.section_key)) || REPORT_TEMPLATE.find(t => t.key === s.section_key)?.title || s.section_key),
      performed: option(s.performed, ['performed','partial','not_performed'] as const),
      notPerformedReason: option(s.not_performed_reason, REASONS), summary: String(s.summary_note || ''),
      items: items.results.filter(i => i.section_key === s.section_key).map(i => ({
        key: String(i.item_key), label: String(i.label || legacyLabels.get(String(i.item_key)) || i.item_key),
        result: i.result === 'not_inspected' && i.not_inspected_reason === 'not_accessible' ? 'not_accessible' : option(i.result, RESULTS),
        notInspectedReason: option(i.not_inspected_reason, REASONS), customerNote: String(i.customer_note || ''),
        internalNotes: String(i.inspector_notes || ''), priority: option(i.priority, PRIORITIES),
        safetyCritical: i.safety_critical === 1, negotiationItem: i.negotiation_item === 1,
        ...(i.measurement_value||i.measurement_unit?{measurement:{value:String(i.measurement_value||''),unit:String(i.measurement_unit||'')}}:{}),
        ...(i.cost_low_cents!==null?{costLowCents:Number(i.cost_low_cents)}:{}),
        ...(i.cost_high_cents!==null?{costHighCents:Number(i.cost_high_cents)}:{}),
      })),
    })) : defaultReportDraft().sections,
  };
}

export function customerReportDraft(draft: ReportDraft, job: ReportJob, photos: ReportPhoto[], createdAt: string, reviewedAt?: string | null, reportRow?:ReportRow): CustomerReportPayload | null {
  return projectCustomerReportPayload({
    schema: 'autoclarity.ppi.report', schemaVersion: 1, inspector: draft.inspectorName,
    inspectedAt: draft.inspectedAt, createdAt, ...(reviewedAt ? { reviewedAt } : {}),
    vehicle: { year: job.year, make: job.make, model: job.model, vin: job.vin,trim:job.vehicle_trim,titleStatus:job.title_status,
      odometerMiles:draft.odometerMiles,vinCheck:reportRow?.vin_check,plate:reportRow?.plate,plateState:reportRow?.plate_state,titleDisclosureNotes:reportRow?.title_disclosure_notes },
    overall: { score: draft.score, verdict: draft.verdict, executiveSummary: draft.executiveSummary,
      positiveFindings: draft.positiveFindings, negotiationSummary: draft.negotiationSummary },
    sections: draft.sections.map(s => ({ title: s.title, performed: s.performed,
      ...(s.notPerformedReason ? { notPerformedReason: s.notPerformedReason } : {}), summary: s.summary,
      items: s.items.map(i => ({ label: i.label, result: i.result,
        note: [i.customerNote, i.notInspectedReason && i.result === 'not_inspected' ? `Not inspected: ${i.notInspectedReason.replaceAll('_',' ')}.` : ''].filter(Boolean).join('\n'),
        ...(i.priority ? { priority: i.priority } : {}),
        ...(i.measurement?{measurement:i.measurement}:{}),...(i.costLowCents!==undefined?{costLowCents:i.costLowCents}:{}),...(i.costHighCents!==undefined?{costHighCents:i.costHighCents}:{}),
        photos: photos.filter(p => p.item_key === i.key).map(p => ({ id: p.id, caption: p.caption || '' })),
      })),
    })),
    limitations: { standard: ['Comprehensive multi-point pre-purchase inspection; findings reflect the vehicle and access available at the inspection time.',
      'This report is not a warranty, guarantee of future condition, or substitute for additional diagnosis where recommended.'], additional: draft.limitationsNotes },
  });
}
export async function reportView(db: D1Database, requestId: string) {
  const job = await loadReportJob(db, requestId);
  const row = await loadReportRow(db, requestId);
  if (!row) return { report: null, requestStatus: job.status, template: REPORT_TEMPLATE, defaultDraft: defaultReportDraft() };
  const [draft, photos, versions, delivery] = await Promise.all([
    loadReportDraft(db, row), loadReportPhotos(db, row.id),
    db.prepare(`SELECT id,version,kind,status,published_at AS publishedAt,amendment_reason AS amendmentReason
      FROM report_versions WHERE report_id=? AND request_id=? ORDER BY version DESC`).bind(row.id, requestId).all(),
    db.prepare(`SELECT delivery_id AS id,message_id AS messageId,status AS emailStatus FROM report_notification_evidence
      WHERE version_id=? ORDER BY CASE WHEN status='sent' THEN 0 ELSE 1 END,depth DESC LIMIT 1`).bind(row.published_version_id).first(),
  ]);
  return { requestStatus: job.status, template: REPORT_TEMPLATE, defaultDraft: defaultReportDraft(), report: {
    id: row.id, state: row.state, seq: row.autosave_seq, publishedVersionId: row.published_version_id,
    publishedAt: row.published_at, reviewedAt: row.reviewed_at, draft,
    preview: row.state==='published'?(await loadPublishedReportVersion(db,requestId))?.payload??null:customerReportDraft(draft,job,photos,row.created_at,row.reviewed_at,row),
    photos: photos.map(p => ({ id: p.id, itemKey: p.item_key, caption: p.caption, contentType: p.content_type, sizeBytes: p.size_bytes,referenced:p.referenced===1 })),
    versions: versions.results, delivery,
  } };
}

function assertSeq(seq: unknown, row: ReportRow): number {
  if (!Number.isSafeInteger(seq) || seq !== row.autosave_seq) throw conflict();
  return Number(seq);
}
function reportAudit(db: D1Database, row: ReportRow, token: string, actor: string, action: string, now: string, newState: string, versionId: string | null = null) {
  return db.prepare(`INSERT INTO report_audit(id,report_id,request_id,version_id,actor,action,prev_state,new_state,created_at)
    SELECT ?,id,request_id,?,?,?,?,?,? FROM inspection_reports WHERE id=? AND write_token=?`)
    .bind(newId('ra'), versionId, actor, action, row.state, newState, now, row.id, token);
}
export async function startReport(db: D1Database, job: ReportJob, actor: string): Promise<void> {
  if (await loadReportRow(db, job.id)) return;
  if (!['confirmed','inspection_in_progress','report_in_progress'].includes(job.status) || job.booking_status !== 'confirmed') throw new ReportError('booking_required', 'Open a confirmed paid booking before starting its inspection.', 409);
  const now = nowIso(); const reportId = newId('rpt');
  const results = await db.batch([
    db.prepare(`INSERT INTO inspection_reports(id,request_id,booking_id,customer_id,vehicle_id,quote_id,state,started_by,created_at,updated_at)
      SELECT ?,r.id,b.id,r.customer_id,r.vehicle_id,b.quote_id,'in_progress',?,?,? FROM ppi_requests r JOIN bookings b ON b.request_id=r.id
      WHERE r.id=? AND r.status IN ('confirmed','inspection_in_progress','report_in_progress') AND r.deleted_at IS NULL AND b.status='confirmed'
        AND EXISTS(SELECT 1 FROM payments p WHERE p.request_id=r.id AND p.quote_id=b.quote_id AND p.status IN ('succeeded','partially_refunded') AND p.amount_cents>p.refunded_cents)
        AND NOT EXISTS(SELECT 1 FROM inspection_reports WHERE request_id=r.id)
      ON CONFLICT(request_id) DO NOTHING`).bind(reportId, actor, now, now, job.id),
    db.prepare(`INSERT INTO status_history(id,request_id,from_status,to_status,actor,reason,related_id,created_at)
      SELECT ?,r.id,'confirmed','inspection_in_progress',?,'Inspection started',?,? FROM ppi_requests r
      WHERE r.id=? AND r.status='confirmed' AND EXISTS(SELECT 1 FROM inspection_reports WHERE id=?)`).bind(newId('sh'),actor,reportId,now,job.id,reportId),
    db.prepare(`UPDATE ppi_requests SET status='inspection_in_progress',updated_at=? WHERE id=? AND status='confirmed'
      AND EXISTS(SELECT 1 FROM inspection_reports WHERE id=?)`).bind(now,job.id,reportId),
    db.prepare(`INSERT INTO report_audit(id,report_id,request_id,actor,action,new_state,created_at)
      SELECT ?,id,request_id,?,'start','in_progress',? FROM inspection_reports WHERE id=?`).bind(newId('ra'),actor,now,reportId),
  ]);
  if (!(results[0]?.meta.changes) && !(await loadReportRow(db,job.id))) throw new ReportError('booking_required','A confirmed booking and captured payment for its exact quote are required.',409);
}

export async function saveReport(db: D1Database, row: ReportRow, seq: unknown, value: unknown, actor: string): Promise<void> {
  assertSeq(seq,row);
  if (row.state === 'published') throw new ReportError('immutable_report','Create an amendment before editing a published report.',409);
  const draft = validateReportDraft(value); const now=nowIso(); const token=newId('rw');
  // Older drafts contain measurement/cost evidence the compact editor does not
  // edit. Preserve it server-side even when an older client omits those fields.
  const previous=await loadReportDraft(db,row);const existing=new Map(previous.sections.flatMap(s=>s.items.map(i=>[i.key,i] as const)));
  for(const s of draft.sections)for(const i of s.items){const old=existing.get(i.key);if(old){i.measurement=old.measurement;i.costLowCents=old.costLowCents;i.costHighCents=old.costHighCents;}}
  const photos=await loadReportPhotos(db,row.id);
  const keys=new Set(draft.sections.flatMap(s=>s.items.map(i=>i.key)));
  if(photos.some(p=>!p.item_key || !keys.has(p.item_key))) throw new ReportError('photo_finding_required','Keep the finding associated with each report photo.');
  const claimed=`EXISTS(SELECT 1 FROM inspection_reports WHERE id=? AND write_token=?)`;
  const sectionValues=JSON.stringify(draft.sections.map(s=>({id:newId('rs'),key:s.key,title:s.title,performed:s.performed,reason:s.notPerformedReason||null,summary:s.summary})));
  const itemValues=JSON.stringify(draft.sections.flatMap(s=>s.items.map(i=>({id:newId('ri'),section:s.key,key:i.key,label:i.label,
    result:i.result==='not_accessible'?'not_inspected':i.result||null,
    reason:i.result==='not_accessible'?'not_accessible':i.notInspectedReason&&i.notInspectedReason!=='not_applicable'?i.notInspectedReason:null,
    internalNotes:i.internalNotes,note:i.customerNote,priority:i.priority||null,safety:i.safetyCritical?1:0,negotiation:i.negotiationItem?1:0,
    measurementValue:i.measurement?.value||null,measurementUnit:i.measurement?.unit||null,low:i.costLowCents??null,high:i.costHighCents??null}))));
  const statements: D1PreparedStatement[] = [db.prepare(`UPDATE inspection_reports SET inspector_name=?,inspected_at=?,odometer_miles=?,score=?,verdict=?,executive_summary=?,positive_findings=?,negotiation_summary=?,limitations_notes=?,state='in_progress',reviewed_at=NULL,reviewed_by=NULL,autosave_seq=autosave_seq+1,updated_at=?,write_token=?
    WHERE id=? AND autosave_seq=? AND state!='published'
    AND EXISTS(SELECT 1 FROM ppi_requests WHERE id=inspection_reports.request_id AND deleted_at IS NULL AND status IN ('inspection_in_progress','report_in_progress','completed'))`)
    .bind(draft.inspectorName,draft.inspectedAt||null,draft.odometerMiles,draft.score,draft.verdict||null,draft.executiveSummary,draft.positiveFindings,draft.negotiationSummary,draft.limitationsNotes,now,token,row.id,seq),
    db.prepare(`DELETE FROM report_items WHERE report_id=? AND item_key NOT IN(SELECT json_extract(value,'$.key') FROM json_each(?)) AND ${claimed}`).bind(row.id,itemValues,row.id,token),
    db.prepare(`DELETE FROM report_sections WHERE report_id=? AND section_key NOT IN(SELECT json_extract(value,'$.key') FROM json_each(?)) AND ${claimed}`).bind(row.id,sectionValues,row.id,token),
    // Two bounded JSON table inserts keep even the 104-item legacy report well
    // within per-request D1 query limits and retain original item ids/timestamps.
    db.prepare(`INSERT INTO report_sections(id,report_id,section_key,title,performed,not_performed_reason,summary_note,updated_at)
      SELECT json_extract(value,'$.id'),?,json_extract(value,'$.key'),json_extract(value,'$.title'),json_extract(value,'$.performed'),json_extract(value,'$.reason'),json_extract(value,'$.summary'),?
      FROM json_each(?) WHERE ${claimed}
      ON CONFLICT(report_id,section_key) DO UPDATE SET title=excluded.title,performed=excluded.performed,not_performed_reason=excluded.not_performed_reason,summary_note=excluded.summary_note,updated_at=excluded.updated_at`)
      .bind(row.id,now,sectionValues,row.id,token),
    db.prepare(`INSERT INTO report_items(id,report_id,section_key,item_key,label,result,not_inspected_reason,inspector_notes,customer_note,priority,safety_critical,negotiation_item,created_at,updated_at,measurement_value,measurement_unit,cost_low_cents,cost_high_cents)
      SELECT json_extract(value,'$.id'),?,json_extract(value,'$.section'),json_extract(value,'$.key'),json_extract(value,'$.label'),json_extract(value,'$.result'),json_extract(value,'$.reason'),json_extract(value,'$.internalNotes'),json_extract(value,'$.note'),json_extract(value,'$.priority'),json_extract(value,'$.safety'),json_extract(value,'$.negotiation'),?,?,json_extract(value,'$.measurementValue'),json_extract(value,'$.measurementUnit'),json_extract(value,'$.low'),json_extract(value,'$.high')
      FROM json_each(?) WHERE ${claimed}
      ON CONFLICT(report_id,item_key) DO UPDATE SET section_key=excluded.section_key,label=excluded.label,result=excluded.result,not_inspected_reason=excluded.not_inspected_reason,inspector_notes=excluded.inspector_notes,customer_note=excluded.customer_note,priority=excluded.priority,safety_critical=excluded.safety_critical,negotiation_item=excluded.negotiation_item,updated_at=excluded.updated_at,measurement_value=excluded.measurement_value,measurement_unit=excluded.measurement_unit,cost_low_cents=excluded.cost_low_cents,cost_high_cents=excluded.cost_high_cents`)
      .bind(row.id,now,now,itemValues,row.id,token),
  ];
  statements.push(reportAudit(db,row,token,actor,'save',now,'in_progress'));
  const results=await db.batch(statements); if(results[0]?.meta.changes!==1)throw conflict();
}

export async function setReportReview(db:D1Database,row:ReportRow,seq:unknown,actor:string,action:'review'|'reopen'|'amend',reason?:unknown):Promise<void>{
  assertSeq(seq,row);
  const now=nowIso(),token=newId('rw'); let amendmentReason=row.amendment_reason;
  if(action==='amend'){
    if(row.state!=='published'||!row.published_version_id)throw new ReportError('wrong_state','Only a published report can be amended.',409);
    amendmentReason=text(reason,2000);if(amendmentReason.length<5)throw new ReportError('validation','Describe why this new report version is necessary.');
  }else if(row.state==='published')throw new ReportError('immutable_report','Create an amendment before changing a published report.',409);
  if(action==='review') validateReportDraft(await loadReportDraft(db,row),true);
  const next=action==='review'?'ready_for_review':'in_progress';
  const results=await db.batch([
    db.prepare(`UPDATE inspection_reports SET state=?,reviewed_at=?,reviewed_by=?,amendment_reason=?,autosave_seq=autosave_seq+1,updated_at=?,write_token=?
      WHERE id=? AND autosave_seq=? AND state=? AND EXISTS(SELECT 1 FROM ppi_requests WHERE id=inspection_reports.request_id
      AND deleted_at IS NULL AND status IN ('inspection_in_progress','report_in_progress','completed'))`)
      .bind(next,action==='review'?now:null,action==='review'?actor:null,amendmentReason,now,token,row.id,seq,row.state),
    db.prepare(`INSERT INTO status_history(id,request_id,from_status,to_status,actor,reason,related_id,created_at)
      SELECT ?,r.id,'inspection_in_progress','report_in_progress',?,'Report ready for review',?,? FROM ppi_requests r
      WHERE r.id=? AND r.status='inspection_in_progress' AND ?='review' AND EXISTS(SELECT 1 FROM inspection_reports WHERE id=? AND write_token=?)`)
      .bind(newId('sh'),actor,row.id,now,row.request_id,action,row.id,token),
    db.prepare(`UPDATE ppi_requests SET status='report_in_progress',updated_at=? WHERE id=? AND status='inspection_in_progress' AND ?='review'
      AND EXISTS(SELECT 1 FROM inspection_reports WHERE id=? AND write_token=?)`).bind(now,row.request_id,action,row.id,token),
    reportAudit(db,row,token,actor,action,now,next),
  ]);
  if(results[0]?.meta.changes!==1)throw conflict();
}

/** Remove a mistaken unpublished attachment from the draft only. The private
 * object is retained; published versions and their evidence are never erased. */
export async function removeDraftPhoto(db:D1Database,row:ReportRow,seq:unknown,photoId:unknown,actor:string):Promise<void>{
  assertSeq(seq,row);if(row.state!=='in_progress')throw new ReportError('draft_required','Return to editing before removing an unpublished photo.',409);
  const photo=typeof photoId==='string'?await db.prepare(`SELECT p.id FROM report_photos p WHERE p.id=? AND p.report_id=? AND p.deleted_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM report_version_photos vp WHERE vp.photo_id=p.id)`).bind(photoId,row.id).first():null;
  if(!photo)throw new ReportError('photo_protected','This photo is unavailable or is immutable published evidence.',409);
  const now=nowIso(),token=newId('rw');
  const results=await db.batch([
    db.prepare(`UPDATE inspection_reports SET autosave_seq=autosave_seq+1,reviewed_at=NULL,reviewed_by=NULL,write_token=?,updated_at=?
      WHERE id=? AND autosave_seq=? AND state='in_progress'
      AND EXISTS(SELECT 1 FROM report_photos p WHERE p.id=? AND p.report_id=inspection_reports.id AND p.deleted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM report_version_photos vp WHERE vp.photo_id=p.id))
      AND EXISTS(SELECT 1 FROM ppi_requests r WHERE r.id=inspection_reports.request_id AND r.deleted_at IS NULL AND r.status IN ('inspection_in_progress','report_in_progress','completed'))`)
      .bind(token,now,row.id,seq,photoId),
    db.prepare(`UPDATE report_photos SET deleted_at=? WHERE id=? AND report_id=?
      AND EXISTS(SELECT 1 FROM inspection_reports WHERE id=? AND write_token=?)`).bind(now,photoId,row.id,row.id,token),
    reportAudit(db,row,token,actor,'remove_unpublished_photo',now,'in_progress'),
  ]);if(results[0]?.meta.changes!==1||results[1]?.meta.changes!==1)throw conflict();
}

export async function sha256Bytes(bytes:Uint8Array):Promise<string>{
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export async function verifiedPhotoBytes(env:Env,p:Pick<ReportPhoto,'object_key'|'sha256'|'size_bytes'>):Promise<ArrayBuffer>{
  if(!p.sha256||!/^[0-9a-f]{64}$/.test(p.sha256)||p.size_bytes<1||p.size_bytes>8388608)throw new ReportError('photo_integrity','Photo evidence requires integrity review.',409);
  const object=await env.UPLOADS.get(p.object_key);
  if(!object||object.size!==p.size_bytes)throw new ReportError('photo_integrity','Photo evidence is unavailable or changed.',409);
  const bytes=await object.arrayBuffer();
  if(bytes.byteLength!==p.size_bytes||await sha256Bytes(new Uint8Array(bytes))!==p.sha256)throw new ReportError('photo_integrity','Photo evidence failed its integrity check.',409);
  return bytes;
}

export async function publishReport(env:Env,job:ReportJob,row:ReportRow,seq:unknown,actor:string):Promise<string>{
  assertSeq(seq,row);
  if(row.state!=='ready_for_review'||!row.reviewed_at||!row.reviewed_by)throw new ReportError('review_required','Save and review the complete report before publishing.',409);
  const draft=validateReportDraft(await loadReportDraft(env.DB,row),true);
  const photos=await loadReportPhotos(env.DB,row.id);
  if(photos.length>60)throw new ReportError('photo_limit','A report supports up to 60 photos.');
  // Sequential reads bound memory while verifying the exact bytes to publish.
  for(const photo of photos)await verifiedPhotoBytes(env,photo);
  const payload=customerReportDraft(draft,job,photos,row.created_at,row.reviewed_at,row);
  if(!payload)throw new ReportError('review_incomplete','The customer report is not valid for publication.');
  const version=(await env.DB.prepare('SELECT COALESCE(MAX(version),0)+1 AS n FROM report_versions WHERE report_id=?').bind(row.id).first<{n:number}>())!.n;
  const now=nowIso(),token=newId('rw'),versionId=newId('rv');
  const payloadJson=JSON.stringify(payload),hash=await sha256Hex(payloadJson);
  if(new TextEncoder().encode(payloadJson).byteLength>900000)throw new ReportError('too_large','The report snapshot is too large.',413);
  const db=env.DB;
  const statements=[
    db.prepare(`UPDATE inspection_reports SET autosave_seq=autosave_seq+1,write_token=?,updated_at=? WHERE id=? AND autosave_seq=? AND state='ready_for_review'
      AND reviewed_at=? AND reviewed_by=? AND published_version_id IS ? AND EXISTS(SELECT 1 FROM ppi_requests WHERE id=inspection_reports.request_id
        AND deleted_at IS NULL AND status IN ('report_in_progress','completed'))`)
      .bind(token,now,row.id,seq,row.reviewed_at,row.reviewed_by,row.published_version_id),
    db.prepare(`INSERT INTO report_versions(id,report_id,request_id,version,status,kind,amendment_reason,payload_json,payload_sha256,published_by,published_at,workflow_revision,created_at,reviewed_at,reviewed_by,previous_version_id)
      SELECT ?,id,request_id,?,'published',?,?,?,?,?,?,1,created_at,reviewed_at,reviewed_by,published_version_id FROM inspection_reports WHERE id=? AND write_token=?`)
      .bind(versionId,version,row.published_version_id?'amendment':'original',row.published_version_id?row.amendment_reason:null,payloadJson,hash,actor,now,row.id,token),
    db.prepare(`INSERT INTO report_version_photos(version_id,photo_id,report_id,request_id,object_key,sha256,content_type,size_bytes)
      SELECT ?,p.id,p.report_id,ir.request_id,p.object_key,p.sha256,p.content_type,p.size_bytes FROM report_photos p
      JOIN inspection_reports ir ON ir.id=p.report_id WHERE ir.id=? AND ir.write_token=? AND p.deleted_at IS NULL`)
      .bind(versionId,row.id,token),
    db.prepare(`INSERT INTO report_deliveries(id,version_id,report_id,request_id,customer_id,channel,created_at,notification_key)
      SELECT ?,?,id,request_id,customer_id,'portal',?,? FROM inspection_reports WHERE id=? AND write_token=?`)
      .bind(newId('rd'),versionId,now,`report_ready:${versionId}`,row.id,token),
    db.prepare(`UPDATE report_versions SET status='superseded',superseded_at=? WHERE id=? AND status='published'
      AND EXISTS(SELECT 1 FROM inspection_reports WHERE id=? AND write_token=?)`).bind(now,row.published_version_id,row.id,token),
    db.prepare(`UPDATE inspection_reports SET published_version_id=?,published_at=?,state='published' WHERE id=? AND write_token=?`).bind(versionId,now,row.id,token),
    reportAudit(db,row,token,actor,'publish',now,'published',versionId),
  ];
  const result=await db.batch(statements);if(result[0]?.meta.changes!==1)throw conflict();
  return versionId;
}

/** A durable portal-delivery record survives failures before the email outbox.
 * Retrying Deliver records/reuses the same version key, never a second event. */
export async function deliverReport(env:Env,job:ReportJob,versionId:string,base:string,waitUntil:(p:Promise<unknown>)=>void):Promise<EmailResult>{
  const d=await env.DB.prepare(`SELECT d.id,d.notification_message_id FROM report_deliveries d JOIN inspection_reports ir ON ir.id=d.report_id
    WHERE d.version_id=? AND d.request_id=? AND ir.published_version_id=d.version_id`).bind(versionId,job.id).first<{id:string;notification_message_id:string|null}>();
  if(!d)throw new ReportError('report_required','Publish this request’s reviewed report before delivery.',409);
  const config=await getConfig(env.DB);
  if(!d.notification_message_id){
    const original=await env.DB.prepare(`SELECT id FROM messages WHERE request_id=? AND dedupe_key=? AND template='report_ready' AND direction='outbound' AND channel='email'`)
      .bind(job.id,`report_ready:${versionId}`).first<{id:string}>();
    if(original)await env.DB.prepare('UPDATE report_deliveries SET notification_message_id=? WHERE id=? AND notification_message_id IS NULL').bind(original.id,d.id).run();
  }
  const existing=await env.DB.prepare(`SELECT m.* FROM report_notification_evidence n JOIN messages m ON m.id=n.message_id
    WHERE n.version_id=? AND n.request_id=? ORDER BY CASE WHEN n.status='sent' THEN 0 ELSE 1 END,n.depth DESC LIMIT 1`)
    .bind(versionId,job.id).first<StoredEmailMessage>();
  if(existing){
    // Preserve provider idempotency and revoked/expired-link handling. A retry
    // outside the provider window requires the existing explicit Messages UI.
    const result=await retryStoredEmail(env,env.DB,existing,config.supportEmail,{config,publicBaseUrl:base});
    if(result.status==='failed'){
      if(result.id===existing.id && existing.status==='recorded')await env.DB.prepare("UPDATE messages SET status='failed',error=? WHERE id=? AND status='recorded'")
        .bind(result.failure||'Report notification retry failed',existing.id).run();
      return result;
    }
    const stored=result.id?await env.DB.prepare('SELECT status FROM messages WHERE id=?').bind(result.id).first<{status:'recorded'|'sent'|'failed'}>():null;
    return stored?{...result,status:stored.status}:result;
  }
  const {token}=await issueMagicLink(env.DB,job.id,config,false);
  const result=await queueTemplate(env,env.DB,job.id,'report_ready',job.email,{
    ref:job.ref,portalUrl:portalUrl(base,token),supportEmail:config.supportEmail,
    extra:{vehicle:[job.year,job.make,job.model].filter(Boolean).join(' ')}},waitUntil,undefined,`report_ready:${versionId}`);
  if(result.id)await env.DB.prepare(`UPDATE report_deliveries SET notification_message_id=? WHERE id=? AND notification_message_id IS NULL`).bind(result.id,d.id).run();
  return result;
}
