export function moacReports(task) {
 if(!Array.isArray(task?.auton_reports))return [];
 const seen=new Set();
 return task.auton_reports.filter(r=>{
  if(!r||r.schema!==1||r.tarea_id!==task.id||r.status!=='ready_for_review'||typeof r.request_id!=='string'||seen.has(r.request_id)||typeof r.summary!=='string'||r.summary.length>2000||!Number.isFinite(Date.parse(r.at)))return false;
  seen.add(r.request_id);return true;
 }).slice(-20).map(r=>({...r,evidence:Array.isArray(r.evidence)?r.evidence.filter(e=>{
  if(!e||typeof e.title!=='string'||e.title.length>160||typeof e.url!=='string')return false;
  try{const u=new URL(e.url);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}
 }).slice(0,8):[]}));
}
