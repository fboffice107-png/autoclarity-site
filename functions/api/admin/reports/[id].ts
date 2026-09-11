import type { Env } from '../../../lib/types.ts';
import { requireAdmin } from '../../../lib/auth.ts';
import { errorJson, json, originAllowed } from '../../../lib/util.ts';
import { readJsonBody, requestBodyErrorResponse } from '../../../lib/request-body.ts';
import { ReportError, deliverReport, loadReportJob, loadReportRow, publishReport, reportView, removeDraftPhoto, saveReport, setReportReview, startReport } from '../../../lib/report-workflow.ts';

export const onRequestGet: PagesFunction<Env> = async ({request,env,params}) => {
  const auth=await requireAdmin(request,env);if(!auth.ok)return auth.response;
  try{return json(await reportView(env.DB,String(params.id||'')));}
  catch(e){if(e instanceof ReportError)return errorJson(e.code,e.message,e.status);throw e;}
};
export const onRequestPost: PagesFunction<Env> = async context => {
  const {request,env,params}=context;
  if(!originAllowed(request,env.PUBLIC_BASE_URL,true))return errorJson('bad_origin','Cross-origin requests are not accepted.',403);
  const auth=await requireAdmin(request,env);if(!auth.ok)return auth.response;
  let body:Record<string,unknown>;
  try{body=await readJsonBody<Record<string,unknown>>(request,900000);}
  catch(e){return requestBodyErrorResponse(e);}
  if(!body||typeof body!=='object'||Array.isArray(body))return errorJson('validation','A report action is required.',422);
  const id=String(params.id||'');
  try{
    const job=await loadReportJob(env.DB,id);
    if(body.action==='start')await startReport(env.DB,job,auth.actor);
    else{
      const row=await loadReportRow(env.DB,id);if(!row)throw new ReportError('report_required','Start this inspection report first.',409);
      switch(body.action){
        case 'save':await saveReport(env.DB,row,body.seq,body.draft,auth.actor);break;
        case 'remove_photo':await removeDraftPhoto(env.DB,row,body.seq,body.photoId,auth.actor);break;
        case 'review':case 'reopen':case 'amend':await setReportReview(env.DB,row,body.seq,auth.actor,body.action,body.amendmentReason);break;
        case 'publish':case 'deliver':{
          const versionId=body.action==='publish'?await publishReport(env,job,row,body.seq,auth.actor):row.published_version_id;
          if(!versionId)throw new ReportError('report_required','Publish the reviewed report first.',409);
          const base=(env.PUBLIC_BASE_URL||new URL(request.url).origin).replace(/\/$/,'');
          try{
            const email=await deliverReport(env,job,versionId,base,p=>context.waitUntil(p));
            return json({...await reportView(env.DB,id),publication:{versionId},emailStatus:email.status,
              notification:{messageId:email.id,emailStatus:email.status,deliveryConfirmed:email.status==='sent'},
              ...(!email.id?{warning:'The immutable report is saved in the portal; retry Deliver to record its email before completion.'}:email.status==='failed'?{warning:email.failure==='idempotency_window_expired'?'Review this request’s Messages section and explicitly confirm a fresh safe retry. The original delivery history is preserved.':'The report is published, but notification delivery failed. Review Messages and retry safely before completion.'}:{})});
          }catch(e){
            if(e instanceof ReportError)throw e;
            console.error(JSON.stringify({event:'report_delivery_pending',requestId:id,versionId}));
            return json({...await reportView(env.DB,id),publication:{versionId},emailStatus:'pending',warning:'The immutable report is saved in the portal. Retry Deliver to prepare its secure notification before completion.'},202);
          }
        }
        default:return errorJson('unknown_action','Unsupported report action.',400);
      }
    }
    return json(await reportView(env.DB,id));
  }catch(e){
    if(e instanceof ReportError)return errorJson(e.code,e.message,e.status);
    console.error(JSON.stringify({event:'report_action_failed',action:String(body.action||'').slice(0,24),requestId:id}));
    return errorJson('report_unavailable','The report action could not be saved. Reload and check the latest saved state before retrying.',503);
  }
};
