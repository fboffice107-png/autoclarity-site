import {describe,expect,it} from 'vitest';
import {defaultReportDraft,type ReportDraft} from '../../functions/lib/report-workflow.ts';
// @ts-expect-error node:fs is used only by this local integration fixture.
import {readFileSync} from 'node:fs';
const BASE='http://127.0.0.1:8799';
const headers={authorization:'Bearer test-admin-key-0123456789abcdef','content-type':'application/json',origin:BASE};
type Json=Record<string,any>;
async function sql(command:string){const response=await fetch('http://127.0.0.1:8798/test/d1',{method:'POST',body:command});if(!response.ok)throw new Error(await response.text());}
async function post(id:string,body:Json){const res=await fetch(`${BASE}/api/admin/reports/${id}`,{method:'POST',headers,body:JSON.stringify(body)});return {status:res.status,body:await res.json() as Json};}
async function get(id:string){const response=await fetch(`${BASE}/api/admin/reports/${id}`,{headers});expect(response.status).toBe(200);return await response.json() as Json;}
async function admin(id:string,body:Json){const response=await fetch(`${BASE}/api/admin/requests/${id}`,{method:'POST',headers,body:JSON.stringify(body)});return {status:response.status,body:await response.json() as Json};}
async function makeJob(){
  const suffix=crypto.randomUUID().replaceAll('-','').slice(0,14),id=`req_fulfill_${suffix}`,now=new Date().toISOString();
  // Synthetic local evidence only. flow.test.ts separately proves the real
  // production authority remains the verified Stripe webhook.
  await sql(`INSERT INTO customers(id,full_name,email,phone,created_at,updated_at)VALUES('c_${suffix}','Synthetic Test','report-${suffix}@example.com','7025550188','${now}','${now}');
    INSERT INTO vehicles(id,year,make,model,created_at,updated_at)VALUES('v_${suffix}',2020,'Synthetic','Test Vehicle','${now}','${now}');
    INSERT INTO ppi_requests(id,ref,customer_id,vehicle_id,status,created_at,updated_at)VALUES('${id}','PPI-FULFILL-${suffix}','c_${suffix}','v_${suffix}','confirmed','${now}','${now}');
    INSERT INTO quotes(id,request_id,version,status,tier,subtotal_cents,total_cents,expires_at,approved_by,created_at,updated_at)VALUES('q_${suffix}','${id}',1,'draft','standard',19900,19900,'2031-01-01','test:owner','${now}','${now}');
    INSERT INTO quote_line_items(id,quote_id,kind,label,amount_cents)VALUES('li_${suffix}','q_${suffix}','base','Synthetic inspection',19900);
    UPDATE quotes SET status='accepted' WHERE id='q_${suffix}';
    INSERT INTO bookings(id,request_id,quote_id,status,created_at,updated_at)VALUES('b_${suffix}','${id}','q_${suffix}','confirmed','${now}','${now}');
    INSERT INTO payments(id,request_id,quote_id,booking_id,status,amount_cents,created_at,updated_at)VALUES('p_${suffix}','${id}','q_${suffix}','b_${suffix}','succeeded',19900,'${now}','${now}');`);
  return id;
}
function completeDraft():ReportDraft{
  const draft=defaultReportDraft();draft.inspectorName='Synthetic Inspector';draft.inspectedAt='2030-01-01T12:00:00Z';draft.score=9;draft.verdict='negotiate_repair_first';
  draft.executiveSummary='<script>not executed</script> Human reviewed findings.';draft.limitationsNotes='No disassembly or unauthorized operation.';
  for(const section of draft.sections){section.performed='performed';section.items[0]!.result='pass';}
  draft.sections[0]!.items[0]!.internalNotes='PRIVATE SYNTHETIC INTERNAL NOTE';
  draft.sections[1]!.performed='not_performed';draft.sections[1]!.notPerformedReason='not_accessible';draft.sections[1]!.items[0]!.result='not_accessible';return draft;
}
async function ready(id:string){
  expect((await post(id,{action:'start'})).status).toBe(200);const view=await get(id);
  const saved=await post(id,{action:'save',seq:view.report.seq,draft:completeDraft()});expect(saved.status).toBe(200);
  const review=await post(id,{action:'review',seq:saved.body.report.seq});expect(review.status).toBe(200);return review.body;
}
async function tokenFor(id:string){const issued=await admin(id,{action:'reissue_link'});expect(issued.status).toBe(200);return new URL(issued.body.url).searchParams.get('t')!;}
async function portal(token:string){const response=await fetch(`${BASE}/api/portal`,{headers:{authorization:`Bearer ${token}`,'cf-connecting-ip':'198.51.100.77'}});return {status:response.status,body:await response.json() as Json};}

describe('report-backed completion through the real authoring HTTP surface',()=>{
  it('rejects missing auth, cross-origin requests, oversized bodies and unknown jobs',async()=>{
    expect((await fetch(`${BASE}/api/admin/reports/not-real`)).status).toBe(401);
    expect((await fetch(`${BASE}/api/admin/reports/not-real`,{method:'POST',headers:{...headers,origin:'https://evil.example'},body:'{}'})).status).toBe(403);
    expect((await fetch(`${BASE}/api/admin/reports/not-real`,{method:'POST',headers,body:JSON.stringify({payload:'x'.repeat(900001)})})).status).toBe(413);
    expect((await post('not-real',{action:'start'})).status).toBe(404);
  });
  it('saves partial drafts and rejects stale autosave and incomplete review without data loss',async()=>{
    const id=await makeJob();let view=(await post(id,{action:'start'})).body;
    const draft=defaultReportDraft();draft.sections[0]!.items[0]!.internalNotes='Partial work preserved';
    const saved=await post(id,{action:'save',seq:view.report.seq,draft});expect(saved.status).toBe(200);
    expect((await post(id,{action:'save',seq:view.report.seq,draft:defaultReportDraft()})).status).toBe(409);
    expect((await post(id,{action:'review',seq:saved.body.report.seq})).status).toBe(422);
    view=await get(id);expect(view.report.draft.sections[0].items[0].internalNotes).toBe('Partial work preserved');
    expect((await post(id,{action:'publish',seq:view.report.seq})).status).toBe(409);
    expect((await portal(await tokenFor(id))).body.report).toBeNull();
  });
  it('publishes and delivers private immutable report plus photos before completion',async()=>{
    const id=await makeJob(),other=await makeJob();let view=await ready(id);
    const image=new Uint8Array([255,216,255,...Array(32).fill(0)]),form=new FormData();
    form.set('file',new Blob([image],{type:'image/jpeg'}),'inspection.jpg');form.set('itemKey','identification_observations');form.set('caption','Authorized evidence');form.set('seq',String(view.report.seq));
    const uploaded=await fetch(`${BASE}/api/admin/report-photos?requestId=${id}`,{method:'POST',headers:{authorization:headers.authorization,origin:BASE},body:form});expect(uploaded.status).toBe(200);
    view=await uploaded.json() as Json;expect(view.report.state).toBe('in_progress');const photoId=view.report.photos[0].id;
    expect((await fetch(`${BASE}/api/admin/report-photos?requestId=${other}&id=${photoId}`,{headers})).status).toBe(404);
    view=(await post(id,{action:'review',seq:view.report.seq})).body;
    expect((await admin(id,{action:'set_status',to:'completed'})).status).toBe(409);
    const published=await post(id,{action:'publish',seq:view.report.seq});expect(published.status).toBe(200);expect(published.body.emailStatus).toBe('recorded');
    const versionId=published.body.publication.versionId,token=await tokenFor(id),otherToken=await tokenFor(other);
    const customer=await portal(token);expect(customer.status).toBe(200);expect(customer.body.report.versionId).toBe(versionId);
    expect(customer.body.report.payload.overall.verdict).toBe('negotiate_repair_first');expect(customer.body.report.payload.sections[1].items[0].result).toBe('not_accessible');
    expect(JSON.stringify(customer.body)).not.toContain('PRIVATE SYNTHETIC INTERNAL NOTE');expect(JSON.stringify(customer.body)).not.toContain('report-evidence/');
    const photoUrl=`${BASE}/api/portal/report-photo?id=${photoId}&versionId=${versionId}`;
    const photo=await fetch(photoUrl,{headers:{authorization:`Bearer ${token}`,'cf-connecting-ip':'198.51.100.78'}});expect(photo.status).toBe(200);expect(photo.headers.get('x-robots-tag')).toContain('noindex');expect(new Uint8Array(await photo.arrayBuffer())).toEqual(image);
    expect((await fetch(photoUrl,{headers:{authorization:`Bearer ${otherToken}`,'cf-connecting-ip':'198.51.100.79'}})).status).toBe(404);expect((await fetch(photoUrl)).status).toBe(401);
    // tokenFor deliberately rotates the initial emailed link. Delivery must
    // preserve that original row and create one safe, non-rotating successor.
    const repeated=await post(id,{action:'deliver'});expect(repeated.body.emailStatus).toBe('recorded');
    expect(repeated.body.notification.messageId).not.toBe(published.body.notification.messageId);
    const deduped=await post(id,{action:'deliver'});expect(deduped.body.notification.messageId).toBe(repeated.body.notification.messageId);
    expect((await admin(id,{action:'set_status',to:'completed'})).status).toBe(200);
    const detail=await fetch(`${BASE}/api/admin/requests/${id}`,{headers}).then(r=>r.json()) as Json;
    expect(detail.request.status).toBe('completed');
    const messages=detail.messages.filter((m:Json)=>m.template==='report_ready');expect(messages).toHaveLength(2);
    expect(messages.find((m:Json)=>m.id===published.body.notification.messageId).dedupe_key).toBe(`report_ready:${versionId}`);
    expect(messages.find((m:Json)=>m.id===repeated.body.notification.messageId).dedupe_key).toBe(`email_link_refresh:${published.body.notification.messageId}`);
    expect(detail.history.filter((h:Json)=>h.to_status==='completed')[0].related_id).toBe(versionId);
    expect((await post(id,{action:'save',seq:published.body.report.seq,draft:completeDraft()})).status).toBe(409);
    const illegal=await fetch('http://127.0.0.1:8798/test/d1',{method:'POST',body:`DELETE FROM report_versions WHERE id='${versionId}';`});expect(illegal.status).toBe(500);expect((await portal(token)).body.report.versionId).toBe(versionId);
  });
  it('keeps the current report available during amendment and publishes a distinct next version',async()=>{
    const id=await makeJob();let view=await ready(id);view=(await post(id,{action:'publish',seq:view.report.seq})).body;
    const first=view.publication.versionId,token=await tokenFor(id);
    expect((await post(id,{action:'amend',seq:view.report.seq,amendmentReason:''})).status).toBe(422);
    view=(await post(id,{action:'amend',seq:view.report.seq,amendmentReason:'Clarify an inspection observation'})).body;expect((await portal(token)).body.report.versionId).toBe(first);
    const draft=view.report.draft;draft.executiveSummary='Amendment with original history retained.';
    view=(await post(id,{action:'save',seq:view.report.seq,draft})).body;view=(await post(id,{action:'review',seq:view.report.seq})).body;view=(await post(id,{action:'publish',seq:view.report.seq})).body;
    expect(view.report.versions).toHaveLength(2);expect(view.report.versions[1].id).toBe(first);expect(view.report.versions[1].status).toBe('superseded');
    const customer=(await portal(token)).body.report;expect(customer.version).toBe(2);expect(customer.kind).toBe('amendment');expect(customer.versionId).not.toBe(first);
  });
  it('rejects MIME mismatch and oversized photos without attaching them',async()=>{
    const id=await makeJob(),view=await ready(id);
    for(const [bytes,type] of [[new Uint8Array([255,216,255,...Array(30).fill(0)]),'image/png'],[new Uint8Array(8*1024*1024+1),'image/jpeg']] as const){
      const form=new FormData();form.set('file',new Blob([bytes],{type}),'photo');form.set('itemKey','identification_observations');form.set('seq',String(view.report.seq));
      expect((await fetch(`${BASE}/api/admin/report-photos?requestId=${id}`,{method:'POST',headers:{authorization:headers.authorization,origin:BASE},body:form})).status).toBe(422);
    }
    expect((await get(id)).report.photos).toHaveLength(0);
  });
  it('roundtrips a real PNG and removes only its unpublished draft attachment',async()=>{
    const id=await makeJob();let view=await ready(id);
    view=(await post(id,{action:'reopen',seq:view.report.seq})).body;
    const bytes=new Uint8Array(readFileSync(new URL('../../assets/img/favicon-32.png',import.meta.url)));
    const form=new FormData();form.set('file',new Blob([bytes],{type:'image/png'}),'synthetic-vehicle-photo.png');
    form.set('itemKey','identification_observations');form.set('seq',String(view.report.seq));
    const uploaded=await fetch(`${BASE}/api/admin/report-photos?requestId=${id}`,{method:'POST',headers:{authorization:headers.authorization,origin:BASE},body:form});expect(uploaded.status).toBe(200);
    view=await uploaded.json() as Json;const photo=view.report.photos[0];expect(photo.referenced).toBe(false);
    const photoUrl=`${BASE}/api/admin/report-photos?requestId=${id}&id=${photo.id}`;
    const response=await fetch(photoUrl,{headers});expect(response.headers.get('content-type')).toBe('image/png');expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    const removed=await post(id,{action:'remove_photo',seq:view.report.seq,photoId:photo.id});expect(removed.status).toBe(200);expect(removed.body.report.photos).toHaveLength(0);
    expect((await fetch(photoUrl,{headers})).status).toBe(404);
    expect((await post(id,{action:'remove_photo',seq:view.report.seq,photoId:photo.id})).status).toBe(409);
  });
});
