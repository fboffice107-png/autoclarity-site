import type { Env } from '../../lib/types.ts';
import { modeFlags } from '../../lib/types.ts';
import { requireAdmin } from '../../lib/auth.ts';
import { errorJson, json, newId, nowIso, originAllowed } from '../../lib/util.ts';
import { readMultipartFormData, requestBodyErrorResponse } from '../../lib/request-body.ts';
import { loadReportJob, loadReportRow, reportView, ReportError, sha256Bytes, verifiedPhotoBytes, type ReportPhoto } from '../../lib/report-workflow.ts';

export const MAX_REPORT_PHOTO_BYTES=8*1024*1024;
export function reportImageType(bytes:Uint8Array):string|null{
  if(bytes.length<12)return null;
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if([137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v))return 'image/png';
  if(String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP')return 'image/webp';
  return null;
}
export const onRequestPost:PagesFunction<Env>=async({request,env})=>{
  if(!originAllowed(request,env.PUBLIC_BASE_URL,true))return errorJson('bad_origin','Cross-origin requests are not accepted.',403);
  const auth=await requireAdmin(request,env);if(!auth.ok)return auth.response;
  if(!modeFlags(env).uploadsEnabled)return errorJson('uploads_disabled','Uploads are switched off.',409);
  const requestId=new URL(request.url).searchParams.get('requestId')||'';
  let form:FormData;try{form=await readMultipartFormData(request,MAX_REPORT_PHOTO_BYTES+65536);}catch(e){return requestBodyErrorResponse(e);}
  try{
    await loadReportJob(env.DB,requestId);const row=await loadReportRow(env.DB,requestId);
    if(!row||row.state==='published')throw new ReportError('draft_required','Open an editable report draft before adding photos.',409);
    const seq=Number(form.get('seq'));if(!Number.isSafeInteger(seq)||seq!==row.autosave_seq)throw new ReportError('conflict','The report changed. Reload before adding a photo.',409);
    const file=form.get('file');if(!(file instanceof File)||file.size<12||file.size>MAX_REPORT_PHOTO_BYTES)throw new ReportError('bad_photo','Choose a JPEG, PNG or WebP image up to 8 MiB.',422);
    const buffer=new Uint8Array(await file.arrayBuffer()),type=reportImageType(buffer);
    if(!type||type!==file.type.toLowerCase())throw new ReportError('bad_type','Image contents must match JPEG, PNG or WebP. Export HEIC photos as JPEG before uploading.',422);
    const itemKey=String(form.get('itemKey')||'');const caption=String(form.get('caption')||'').trim();
    if(caption.length>1000)throw new ReportError('validation','Photo captions must be no longer than 1,000 characters.');
    const item=await env.DB.prepare('SELECT id FROM report_items WHERE report_id=? AND item_key=?').bind(row.id,itemKey).first();
    if(!item)throw new ReportError('finding_required','Save this finding before attaching its photo.',409);
    const id=newId('rp'),token=newId('rw'),now=nowIso(),hash=await sha256Bytes(buffer);
    // Opaque content-addressed-in-manifest UUID key; never accept a client key,
    // overwrite an existing object, or reuse customer intake-upload storage.
    const objectKey=`report-evidence/${crypto.randomUUID()}`;
    const stored=await env.UPLOADS.put(objectKey,buffer,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:type},sha256:hash});
    if(!stored)throw new ReportError('photo_conflict','The photo could not be stored safely. Retry with the original image.',409);
    const result=await env.DB.batch([
      env.DB.prepare(`UPDATE inspection_reports SET autosave_seq=autosave_seq+1,state='in_progress',reviewed_at=NULL,reviewed_by=NULL,write_token=?,updated_at=?
        WHERE id=? AND autosave_seq=? AND state!='published'
        AND (SELECT COUNT(*) FROM report_photos WHERE report_id=? AND deleted_at IS NULL)<60
        AND EXISTS(SELECT 1 FROM report_items WHERE report_id=? AND item_key=?)
        AND EXISTS(SELECT 1 FROM ppi_requests WHERE id=inspection_reports.request_id AND deleted_at IS NULL AND status IN ('inspection_in_progress','report_in_progress','completed'))`)
        .bind(token,now,row.id,seq,row.id,row.id,itemKey),
      env.DB.prepare(`INSERT INTO report_photos(id,report_id,item_key,object_key,content_type,size_bytes,caption,sha256,created_at)
        SELECT ?,id,?,?,?,?,?,?,? FROM inspection_reports WHERE id=? AND write_token=?`).bind(id,itemKey,objectKey,type,buffer.byteLength,caption,hash,now,row.id,token),
      env.DB.prepare(`INSERT INTO report_audit(id,report_id,request_id,actor,action,details_json,created_at)
        SELECT ?,id,request_id,?,'photo_added',?,? FROM inspection_reports WHERE id=? AND write_token=?`)
        .bind(newId('ra'),auth.actor,JSON.stringify({photoId:id,sha256:hash}),now,row.id,token),
    ]);
    if(result[0]?.meta.changes!==1){
      // This unreferenced upload was created by this exact request only.
      await env.UPLOADS.delete(objectKey);
      throw new ReportError('conflict','The report changed or reached 60 photos. Reload before retrying.',409);
    }
    return json(await reportView(env.DB,requestId));
  }catch(e){if(e instanceof ReportError)return errorJson(e.code,e.message,e.status);console.error(JSON.stringify({event:'report_photo_upload_failed',requestId}));return errorJson('photo_unavailable','Photo could not be attached. Reload the report before retrying.',503);}
};
export const onRequestGet:PagesFunction<Env>=async({request,env})=>{
  const auth=await requireAdmin(request,env);if(!auth.ok)return auth.response;
  const url=new URL(request.url);
  const photo=await env.DB.prepare(`SELECT p.* FROM report_photos p JOIN inspection_reports ir ON ir.id=p.report_id
    JOIN ppi_requests r ON r.id=ir.request_id WHERE p.id=? AND ir.request_id=? AND p.deleted_at IS NULL AND r.deleted_at IS NULL`)
    .bind(url.searchParams.get('id')||'',url.searchParams.get('requestId')||'').first<ReportPhoto>();
  if(!photo)return errorJson('not_found','Photo not found.',404);
  try{return reportPhotoResponse(await verifiedPhotoBytes(env,photo),photo.content_type);}
  catch{return errorJson('photo_integrity','Photo is unavailable pending an integrity review.',409);}
};
export function reportPhotoResponse(bytes:ArrayBuffer,type:string):Response{
  return new Response(bytes,{headers:{'content-type':type,'content-disposition':'inline; filename="inspection-photo"','x-content-type-options':'nosniff',
    'content-security-policy':"default-src 'none'; sandbox",'cache-control':'private, no-store','x-robots-tag':'noindex, nofollow','referrer-policy':'no-referrer'}});
}
