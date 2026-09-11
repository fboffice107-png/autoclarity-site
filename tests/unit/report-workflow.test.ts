/// <reference types="vite/client" />
import {describe,expect,it,vi} from 'vitest';
// @ts-expect-error node:sqlite is intentionally outside Worker runtime types.
import {DatabaseSync} from 'node:sqlite';
import init from '../../migrations/0001_init.sql?raw';
import reports from '../../migrations/0002_inspection_reports.sql?raw';
import fulfillment from '../../migrations/0011_report_fulfillment_integrity.sql?raw';
import {completeWithPublishedReport,loadPublishedReportVersion} from '../../functions/lib/published-report.ts';
import {customerReportDraft,defaultReportDraft,deliverReport,loadReportDraft,loadReportJob,loadReportRow,publishReport,removeDraftPhoto,reportView,saveReport,setReportReview,startReport,validateReportDraft,verifiedPhotoBytes,sha256Bytes,type ReportDraft} from '../../functions/lib/report-workflow.ts';
import {reportImageType} from '../../functions/api/admin/report-photos.ts';
import {requirePortal,requirePortalAsset} from '../../functions/lib/portal.ts';
import {issueMagicLink,portalUrl} from '../../functions/lib/magic.ts';
import {DEFAULT_CONFIG} from '../../functions/lib/config.ts';
import {retryStoredEmail,sendTemplate,type StoredEmailMessage} from '../../functions/lib/email.ts';
import type {Env} from '../../functions/lib/types.ts';

interface SQLite {exec(sql:string):void;prepare(sql:string):{get(...v:unknown[]):unknown;all(...v:unknown[]):unknown[];run(...v:unknown[]):{changes:number|bigint}};close():void}
function d1(sqlite:SQLite):D1Database{
  const statement=(sql:string,values:unknown[]=[]):D1PreparedStatement=>({
    bind(...v:unknown[]){return statement(sql,v);},
    async first<T>(){return (sqlite.prepare(sql).get(...values)??null) as T|null;},
    async all<T>(){return {success:true,results:sqlite.prepare(sql).all(...values),meta:{}} as unknown as D1Result<T>;},
    async run<T>(){return {success:true,results:[],meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}} as unknown as D1Result<T>;},
  }) as D1PreparedStatement;
  let tail:Promise<unknown>=Promise.resolve();
  return {prepare:(s:string)=>statement(s),batch(statements:D1PreparedStatement[]){
    const job=tail.then(async()=>{sqlite.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}});
    tail=job.catch(()=>undefined);return job;
  }} as unknown as D1Database;
}
function seed(){
  const sqlite=new DatabaseSync(':memory:') as SQLite;sqlite.exec('PRAGMA foreign_keys=ON;');sqlite.exec(init);sqlite.exec(reports);sqlite.exec(fulfillment);
  sqlite.exec(`INSERT INTO customers(id,full_name,email,phone,created_at,updated_at)VALUES('c','Test Customer','report@example.com','7025550111','2030-01-01','2030-01-01');
    INSERT INTO vehicles(id,year,make,model,created_at,updated_at)VALUES('v',2020,'Synthetic','Vehicle','2030-01-01','2030-01-01');
    INSERT INTO ppi_requests(id,ref,customer_id,vehicle_id,status,created_at,updated_at)VALUES('r','PPI-TEST','c','v','confirmed','2030-01-01','2030-01-01');
    INSERT INTO quotes(id,request_id,version,status,tier,subtotal_cents,total_cents,expires_at,approved_by,created_at,updated_at)VALUES('q','r',1,'accepted','standard',19900,19900,'2031-01-01','owner','2030-01-01','2030-01-01');
    INSERT INTO bookings(id,request_id,quote_id,status,created_at,updated_at)VALUES('b','r','q','confirmed','2030-01-01','2030-01-01');
    INSERT INTO payments(id,request_id,quote_id,booking_id,status,amount_cents,created_at,updated_at)VALUES('p','r','q','b','succeeded',19900,'2030-01-01','2030-01-01');`);
  const db=d1(sqlite);const env={DB:db,PPI_ENV:'preview',UPLOADS:{get:async()=>null},RESEND_API_KEY:'',PUBLIC_BASE_URL:'https://example.com'} as unknown as Env;
  return {sqlite,db,env};
}
function readyDraft():ReportDraft{
  const draft=defaultReportDraft();draft.inspectorName='Synthetic Inspector';draft.inspectedAt='2030-01-01T12:00:00Z';draft.score=8;
  draft.verdict='negotiate_repair_first';draft.executiveSummary='Owner-selected guidance, not a score-derived verdict.';draft.limitationsNotes='No disassembly; unavailable seller areas were not accessed.';
  for(const s of draft.sections){s.performed='performed';s.items[0]!.result='pass';}
  draft.sections[0]!.items[0]!.internalNotes='NEVER CUSTOMER VISIBLE';return draft;
}
async function reviewed(s:ReturnType<typeof seed>){
  const job=await loadReportJob(s.db,'r');await startReport(s.db,job,'admin:owner');let row=(await loadReportRow(s.db,'r'))!;
  await saveReport(s.db,row,row.autosave_seq,readyDraft(),'admin:owner');row=(await loadReportRow(s.db,'r'))!;
  await setReportReview(s.db,row,row.autosave_seq,'admin:reviewer','review');return (await loadReportRow(s.db,'r'))!;
}
async function published(s:ReturnType<typeof seed>){const row=await reviewed(s);return publishReport(s.env,await loadReportJob(s.db,'r'),row,row.autosave_seq,'admin:publisher');}

describe('report draft validation',()=>{
  it('defaults every finding to an unselected result and never computes buyer guidance',()=>{
    const draft=defaultReportDraft();expect(draft.verdict).toBe('');expect(draft.score).toBeNull();expect(draft.sections.every(s=>s.items.every(i=>i.result===''))).toBe(true);
    expect(()=>validateReportDraft(draft,true)).toThrow();const explicit=readyDraft();explicit.score=10;expect(validateReportDraft(explicit,true).verdict).toBe('negotiate_repair_first');
  });
  it('requires truthful unavailable states, reasons and concern explanations',()=>{
    const draft=readyDraft();draft.sections[0]!.items[0]!.result='not_accessible';expect(()=>validateReportDraft(draft,true)).toThrow(/partially/);
    draft.sections[0]!.performed='not_performed';draft.sections[0]!.notPerformedReason='not_accessible';expect(validateReportDraft(draft,true).sections[0]!.items[0]!.notInspectedReason).toBe('not_accessible');
    draft.sections[1]!.items[0]!.result='fail';expect(()=>validateReportDraft(draft,true)).toThrow(/Explain/);
  });
  it('rejects duplicate keys, unknown states, oversized text and invalid dates',()=>{
    const d=readyDraft();d.sections[1]!.items[0]!.key=d.sections[0]!.items[0]!.key;expect(()=>validateReportDraft(d)).toThrow(/unique/);
    expect(()=>validateReportDraft({...readyDraft(),inspectedAt:'never'})).toThrow(/date/);
    expect(()=>validateReportDraft({...readyDraft(),executiveSummary:'x'.repeat(12001)})).toThrow(/long/);
    expect(()=>validateReportDraft({...readyDraft(),verdict:'auto_pass'})).toThrow(/state/);
  });
  it('sniffs supported image bytes and rejects SVG, HEIC and forged PNG prefixes',()=>{
    expect(reportImageType(new Uint8Array([255,216,255,...Array(12).fill(0)]))).toBe('image/jpeg');
    expect(reportImageType(new TextEncoder().encode('<svg onload="alert(1)">'))).toBeNull();
    expect(reportImageType(new Uint8Array([137,80,78,71,...Array(12).fill(0)]))).toBeNull();
  });
});
describe('atomic report fulfillment',()=>{
  it('requires a confirmed captured booking and creates no report or history on failure',async()=>{
    const s=seed();try{s.sqlite.exec("UPDATE payments SET status='created'");await expect(startReport(s.db,await loadReportJob(s.db,'r'),'admin:owner')).rejects.toThrow(/captured/);
      expect(await loadReportRow(s.db,'r')).toBeNull();expect(s.sqlite.prepare('SELECT COUNT(*) n FROM status_history').get()).toEqual({n:0});}finally{s.sqlite.close();}
  });
  it('retains partial autosave, prevents stale overwrite, invalidates review, and audits actors',async()=>{
    const s=seed();try{const row=await reviewed(s);const draft=await loadReportDraft(s.db,row);draft.executiveSummary='Updated saved text';
      await saveReport(s.db,row,row.autosave_seq,draft,'admin:second');await expect(saveReport(s.db,row,row.autosave_seq,readyDraft(),'admin:stale')).rejects.toThrow(/another window/);
      const current=(await loadReportRow(s.db,'r'))!;expect(current.state).toBe('in_progress');expect(current.reviewed_at).toBeNull();expect(current.executive_summary).toBe('Updated saved text');
      expect(s.sqlite.prepare("SELECT COUNT(*) n FROM report_audit WHERE actor='admin:stale'").get()).toEqual({n:0});
      await expect(publishReport(s.env,await loadReportJob(s.db,'r'),current,current.autosave_seq,'admin:second')).rejects.toThrow(/review/);
    }finally{s.sqlite.close();}
  });
  it('lets only one concurrent publish win, strips internal notes, and requires durable notification before completion',async()=>{
    const s=seed();try{const row=await reviewed(s);const job=await loadReportJob(s.db,'r');
      const raced=await Promise.allSettled([publishReport(s.env,job,row,row.autosave_seq,'admin:one'),publishReport(s.env,job,row,row.autosave_seq,'admin:two')]);
      expect(raced.filter(r=>r.status==='fulfilled')).toHaveLength(1);const report=(await loadPublishedReportVersion(s.db,'r'))!;
      expect(report.payload.overall.verdict).toBe('negotiate_repair_first');expect(JSON.stringify(report)).not.toContain('NEVER CUSTOMER VISIBLE');
      expect(await completeWithPublishedReport(s.db,'r','admin:owner')).toEqual({ok:false,code:'report_required'});
      expect(()=>s.sqlite.exec("UPDATE ppi_requests SET status='completed' WHERE id='r'")).toThrow(/delivery/);
      const email=await deliverReport(s.env,job,report.versionId,'https://example.com',()=>{throw new Error('No real email allowed');});expect(email.status).toBe('recorded');
      const replay=await deliverReport(s.env,job,report.versionId,'https://example.com',()=>{});expect(replay.id).toBe(email.id);
      expect((await completeWithPublishedReport(s.db,'r','admin:owner')).ok).toBe(true);
      expect(s.sqlite.prepare("SELECT COUNT(*) n FROM messages WHERE template='report_ready'").get()).toEqual({n:1});
      expect(s.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    }finally{s.sqlite.close();}
  });
  it('preserves prior version and portal visibility while drafting a reasoned amendment, then advances exactly once',async()=>{
    const s=seed();try{const old=await published(s);const before=s.sqlite.prepare('SELECT payload_json,payload_sha256 FROM report_versions WHERE id=?').get(old);
      let row=(await loadReportRow(s.db,'r'))!;await expect(setReportReview(s.db,row,row.autosave_seq,'admin:owner','amend','')).rejects.toThrow(/why/);
      await setReportReview(s.db,row,row.autosave_seq,'admin:owner','amend','Correct a documented finding');expect((await loadPublishedReportVersion(s.db,'r'))?.versionId).toBe(old);
      row=(await loadReportRow(s.db,'r'))!;const draft=await loadReportDraft(s.db,row);draft.executiveSummary='Amended finding';await saveReport(s.db,row,row.autosave_seq,draft,'admin:owner');
      row=(await loadReportRow(s.db,'r'))!;await setReportReview(s.db,row,row.autosave_seq,'admin:reviewer','review');row=(await loadReportRow(s.db,'r'))!;
      const next=await publishReport(s.env,await loadReportJob(s.db,'r'),row,row.autosave_seq,'admin:publisher');expect(next).not.toBe(old);
      expect(s.sqlite.prepare('SELECT payload_json,payload_sha256 FROM report_versions WHERE id=?').get(old)).toEqual(before);
      expect(s.sqlite.prepare('SELECT status FROM report_versions WHERE id=?').get(old)).toEqual({status:'superseded'});
      expect((await loadPublishedReportVersion(s.db,'r'))?.version).toBe(2);
    }finally{s.sqlite.close();}
  });
  it('prevents immutable body, metadata, pointer, deletion, replacement and fake-legacy bypasses',async()=>{
    const s=seed();try{const id=await published(s);const row=(await loadReportRow(s.db,'r'))!;
      const forbidden=["UPDATE report_versions SET payload_json='{}'", "UPDATE report_versions SET amendment_reason='rewrite'",'DELETE FROM report_versions',
        'DELETE FROM inspection_reports',"UPDATE inspection_reports SET published_version_id=NULL",'DELETE FROM report_deliveries','DELETE FROM report_audit',
        "INSERT OR REPLACE INTO report_versions SELECT * FROM report_versions",'INSERT OR REPLACE INTO inspection_reports SELECT * FROM inspection_reports',
        'INSERT OR REPLACE INTO report_deliveries SELECT * FROM report_deliveries','INSERT OR REPLACE INTO report_audit SELECT * FROM report_audit',
        `INSERT INTO report_versions(id,report_id,request_id,version,payload_json,payload_sha256,published_by,published_at)VALUES('forged','${row.id}','r',9,'{}','${'0'.repeat(64)}','x','2030-01-01')`];
      for(const sql of forbidden)expect(()=>s.sqlite.exec(sql),sql).toThrow();
      expect((await loadPublishedReportVersion(s.db,'r'))?.versionId).toBe(id);
    }finally{s.sqlite.close();}
  });
  it('binds photo bytes and manifests, rejects corrupt bytes and protects referenced evidence from replacement',async()=>{
    const s=seed();try{await reviewed(s);let row=(await loadReportRow(s.db,'r'))!;
      const bytes=new Uint8Array([255,216,255,...Array(20).fill(0)]),hash=await sha256Bytes(bytes);
      s.sqlite.prepare(`INSERT INTO report_photos(id,report_id,item_key,object_key,content_type,size_bytes,sha256,created_at)VALUES('rp_test',?,'identification_observations','opaque','image/jpeg',?,?,?)`).run(row.id,bytes.length,hash,'2030-01-01');
      s.env.UPLOADS={get:async()=>({size:bytes.length,arrayBuffer:async()=>bytes.buffer})} as unknown as R2Bucket;
      const id=await publishReport(s.env,await loadReportJob(s.db,'r'),row,row.autosave_seq,'admin:owner');
      expect((await loadPublishedReportVersion(s.db,'r'))?.payload.sections[0]!.items[0]!.photos).toEqual([{id:'rp_test'}]);
      for(const sql of ["UPDATE report_photos SET object_key='other'","UPDATE report_photos SET deleted_at='2031-01-01'",'DELETE FROM report_photos','DELETE FROM report_version_photos','INSERT OR REPLACE INTO report_photos SELECT * FROM report_photos','INSERT OR REPLACE INTO report_version_photos SELECT * FROM report_version_photos'])expect(()=>s.sqlite.exec(sql)).toThrow();
      bytes[6]=1;await expect(verifiedPhotoBytes(s.env,{object_key:'opaque',size_bytes:bytes.length,sha256:hash})).rejects.toThrow(/integrity/);
      expect(s.sqlite.prepare('SELECT version_id FROM report_version_photos').get()).toEqual({version_id:id});
    }finally{s.sqlite.close();}
  });
  it('preserves legacy measurement and cost data even when the editor omits it',async()=>{
    const s=seed();try{await reviewed(s);s.sqlite.exec("UPDATE report_items SET measurement_value='6',measurement_unit='mm',cost_low_cents=1000,cost_high_cents=2000 WHERE item_key='identification_observations'");
      const row=(await loadReportRow(s.db,'r'))!;await saveReport(s.db,row,row.autosave_seq,readyDraft(),'admin:owner');
      const after=await loadReportDraft(s.db,(await loadReportRow(s.db,'r'))!);expect(after.sections[0]!.items[0]).toMatchObject({measurement:{value:'6',unit:'mm'},costLowCents:1000,costHighCents:2000});
    }finally{s.sqlite.close();}
  });
  it('reconstructs 104 legacy items without section rows and never replaces them with a blank checklist',async()=>{
    const s=seed();try{await reviewed(s);const row=(await loadReportRow(s.db,'r'))!;
      s.sqlite.exec('DELETE FROM report_items; DELETE FROM report_sections;');
      for(let n=0;n<104;n++)s.sqlite.prepare(`INSERT INTO report_items(id,report_id,section_key,item_key,result,customer_note,inspector_notes,measurement_value,measurement_unit,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'2030-01-01','2030-01-01')`).run(`old_${n}`,row.id,`legacy_${n%18}`,`item_${n}`,'pass',`Preserved finding ${n}`,`Internal ${n}`,'6','mm');
      const before=s.sqlite.prepare('SELECT * FROM report_items ORDER BY id').all();
      const draft=await loadReportDraft(s.db,row);expect(draft.sections).toHaveLength(18);expect(draft.sections.flatMap(s=>s.items)).toHaveLength(104);
      expect(draft.sections.flatMap(s=>s.items).find(i=>i.key==='item_103')).toMatchObject({customerNote:'Preserved finding 103',internalNotes:'Internal 103',measurement:{value:'6',unit:'mm'}});
      expect(s.sqlite.prepare('SELECT * FROM report_items ORDER BY id').all()).toEqual(before);
    }finally{s.sqlite.close();}
  });
  it('serves exact immutable published preview even if editable vehicle metadata changes',async()=>{
    const s=seed();try{await published(s);const before=(await reportView(s.db,'r')).report!.preview;
      s.sqlite.exec("UPDATE vehicles SET model='Later different vehicle text' WHERE id='v'");
      expect((await reportView(s.db,'r')).report!.preview).toEqual(before);
    }finally{s.sqlite.close();}
  });
  it('accepts all 60 supported photos on one finding and removes only unpublished draft attachments',async()=>{
    const s=seed();try{const row=await reviewed(s),job=await loadReportJob(s.db,'r');
      const photos=Array.from({length:60},(_,n)=>({id:`rp_${n}`,item_key:'identification_observations',caption:'',object_key:`private_${n}`,sha256:'0'.repeat(64),content_type:'image/jpeg',size_bytes:20}));
      expect(customerReportDraft(readyDraft(),job,photos,row.created_at,row.reviewed_at,row)?.sections[0]!.items[0]!.photos).toHaveLength(60);
      await setReportReview(s.db,row,row.autosave_seq,'admin:owner','reopen');const draftRow=(await loadReportRow(s.db,'r'))!;
      s.sqlite.prepare(`INSERT INTO report_photos(id,report_id,item_key,object_key,content_type,size_bytes,sha256,created_at)VALUES('rp_mistake',?,'identification_observations','private_mistake','image/jpeg',20,?,'2030-01-01')`).run(row.id,'0'.repeat(64));
      await removeDraftPhoto(s.db,draftRow,draftRow.autosave_seq,'rp_mistake','admin:owner');
      expect((await reportView(s.db,'r')).report!.photos).toHaveLength(0);
      expect(s.sqlite.prepare("SELECT object_key,deleted_at FROM report_photos WHERE id='rp_mistake'").get()).toEqual({object_key:'private_mistake',deleted_at:expect.any(String)});
      await expect(removeDraftPhoto(s.db,draftRow,draftRow.autosave_seq,'rp_mistake','admin:owner')).rejects.toThrow();
    }finally{s.sqlite.close();}
  });
  it('loads and refreshes a full 60-photo report without consuming interactive portal budget, while bounding invalid tokens',async()=>{
    const s=seed();try{const {token}=await issueMagicLink(s.db,'r',DEFAULT_CONFIG,false);
      const request=new Request('https://example.com/api/portal/report-photo',{headers:{authorization:`Bearer ${token}`,'cf-connecting-ip':'198.51.100.80'}});
      for(let n=0;n<121;n++)expect((await requirePortalAsset(request,s.env)).ok).toBe(true);
      expect((await requirePortal(request,s.env)).ok).toBe(true);
      expect(s.sqlite.prepare("SELECT count FROM rate_limits WHERE bucket LIKE 'portal_token:%'").get()).toEqual({count:1});
      const invalid=new Request('https://example.com/api/portal/report-photo',{headers:{authorization:'Bearer invalid','cf-connecting-ip':'198.51.100.81'}});
      for(let n=0;n<60;n++){const auth=await requirePortalAsset(invalid,s.env);expect(auth.ok).toBe(false);if(!auth.ok)expect(auth.response.status).toBe(401);}
      const blocked=await requirePortalAsset(invalid,s.env);expect(blocked.ok).toBe(false);if(!blocked.ok)expect(blocked.response.status).toBe(429);
      s.sqlite.exec("UPDATE magic_links SET revoked_at='2030-01-01' WHERE request_id='r'");expect((await requirePortalAsset(request,s.env)).ok).toBe(false);
    }finally{s.sqlite.close();}
  });
  it('recovers an outbox-before-pointer crash through safe revoked-link retry and retains original notification identity',async()=>{
    const s=seed();try{const id=await published(s),job=await loadReportJob(s.db,'r');
      const {token}=await issueMagicLink(s.db,'r',DEFAULT_CONFIG,false);
      const original=await sendTemplate(s.env,s.db,'r','report_ready',job.email,{ref:job.ref,portalUrl:portalUrl('https://example.com',token),supportEmail:'support@example.com'},undefined,`report_ready:${id}`);
      s.sqlite.exec("UPDATE magic_links SET revoked_at='2030-01-01' WHERE request_id='r'");
      const retry=await deliverReport(s.env,job,id,'https://example.com',()=>{});expect(retry.status).toBe('recorded');expect(retry.id).not.toBe(original.id);
      expect(s.sqlite.prepare('SELECT notification_message_id FROM report_deliveries WHERE version_id=?').get(id)).toEqual({notification_message_id:original.id});
      expect(s.sqlite.prepare('SELECT dedupe_key FROM messages WHERE id=?').get(retry.id)).toEqual({dedupe_key:`email_link_refresh:${original.id}`});
      expect((await completeWithPublishedReport(s.db,'r','admin:owner')).ok).toBe(true);
    }finally{s.sqlite.close();}
  });
  it('requires explicit fresh retry after provider window and accepts its sent successor without rewriting original failure',async()=>{
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2030-02-01T12:00:00Z'));
    const s=seed();try{const id=await published(s),job=await loadReportJob(s.db,'r');const original=await deliverReport(s.env,job,id,'https://example.com',()=>{});
      vi.setSystemTime(new Date('2030-02-03T12:00:00Z'));
      const refused=await deliverReport(s.env,job,id,'https://example.com',()=>{});expect(refused).toMatchObject({status:'failed',failure:'idempotency_window_expired'});
      expect((await completeWithPublishedReport(s.db,'r','admin:owner')).ok).toBe(false);
      const stored=await s.db.prepare('SELECT * FROM messages WHERE id=?').bind(original.id).first<StoredEmailMessage>();
      s.env.RESEND_API_KEY='synthetic-mock-key';s.env.EMAIL_FROM='AutoClarity <test@example.com>';
      const mock=vi.fn(async()=>new Response(JSON.stringify({id:'mock_delivery'}),{status:200,headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',mock);
      const fresh=await retryStoredEmail(s.env,s.db,stored!,'support@example.com',{config:DEFAULT_CONFIG,publicBaseUrl:'https://example.com',confirmFreshAfterWindow:true});
      expect(fresh.status).toBe('sent');expect(fresh.id).not.toBe(original.id);expect(mock).toHaveBeenCalledTimes(1);
      expect(s.sqlite.prepare('SELECT status FROM messages WHERE id=?').get(original.id)).toEqual({status:'failed'});
      expect((await completeWithPublishedReport(s.db,'r','admin:owner')).ok).toBe(true);
      for(const statement of ['DELETE FROM messages',"UPDATE messages SET body_text='rewritten'","INSERT OR REPLACE INTO messages SELECT * FROM messages"])expect(()=>s.sqlite.exec(statement)).toThrow();
    }finally{s.sqlite.close();vi.unstubAllGlobals();vi.useRealTimers();}
  });
});
