import type { Env } from '../../lib/types.ts';
import { requirePortalAsset } from '../../lib/portal.ts';
import { errorJson } from '../../lib/util.ts';
import { verifiedPhotoBytes, type ReportPhoto } from '../../lib/report-workflow.ts';
import { reportPhotoResponse } from '../admin/report-photos.ts';

export const onRequestGet:PagesFunction<Env>=async({request,env})=>{
  const auth=await requirePortalAsset(request,env);if(!auth.ok)return auth.response;
  const url=new URL(request.url);
  // Only a delivered immutable version belonging to this exact portal request.
  // Superseded evidence is retained and readable through its original version.
  const photo=await env.DB.prepare(`SELECT vp.object_key,vp.sha256,vp.size_bytes,vp.content_type FROM report_version_photos vp
    JOIN report_versions rv ON rv.id=vp.version_id AND rv.report_id=vp.report_id AND rv.request_id=vp.request_id
    JOIN report_deliveries d ON d.version_id=rv.id AND d.request_id=rv.request_id
    JOIN ppi_requests r ON r.id=rv.request_id AND r.customer_id=d.customer_id
    WHERE vp.photo_id=? AND vp.version_id=? AND vp.request_id=? AND r.deleted_at IS NULL`)
    .bind(url.searchParams.get('id')||'',url.searchParams.get('versionId')||'',auth.requestId).first<ReportPhoto>();
  if(!photo)return errorJson('not_found','Photo not found.',404);
  try{return reportPhotoResponse(await verifiedPhotoBytes(env,photo),photo.content_type);}
  catch{return errorJson('photo_integrity','Photo is unavailable pending an integrity review.',409);}
};
