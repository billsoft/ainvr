// Explicit offline export/score. No alarm writes and no automatic qualification.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import {reviewDescription,REVIEW_PROMPT_VERSION} from '../../alarm-service/src/review-prompt.mjs';
const root=resolve(import.meta.dirname,'../..');
const hash=x=>createHash('sha256').update(x).digest('hex');
async function json(url,headers={},body){
 const response=await fetch(url,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(120000),headers:{...headers,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 if(!response.ok)throw Error('HTTP '+response.status);return response.json();
}
async function config(service){
 const bootstrap=JSON.parse(await readFile(join(root,`deploy/s100p/runtime/${service}-bootstrap.json`),'utf8'));
 const url=new URL('/api/v1/config/',bootstrap.control_url),headers={'x-service-token':bootstrap.service_token};
 const state=await json(new URL('service-states/'+service,url),headers);
 const snap=await json(new URL(`versions/${state.data.appliedVersion}/snapshot?service=${service}`,url),headers);
 return snap.data[0].config;
}
const [mode,input,output]=process.argv.slice(2);
if(!['export','score'].includes(mode)||!input||!output)throw Error('Usage: node review_alarm_dataset.mjs export <alarm-ids.json> <new-directory> OR score <annotated-manifest.json> <new-report.json>');
if(mode==='export'){
 const ids=JSON.parse(await readFile(input,'utf8'));if(!Array.isArray(ids)||!ids.length||ids.length>200)throw Error('Choose 1–200 alarm IDs');
 await mkdir(output,{mode:0o700});const cfg=await config('alarm-service'),url=`http://127.0.0.1:${cfg.port}`,headers={Authorization:'Bearer '+cfg.api_token},items=[],skipped=[];
 for(const id of [...new Set(ids)]){
  const row=await json(url+'/v1/events/'+encodeURIComponent(id),headers);
  if(row.handling?.reviewed_by_kind==='ai'||row.handling.state!=='acknowledged'){skipped.push({id,reason:'not_human_reviewed'});continue;}
  if(!row.review?.frames?.length){skipped.push({id,reason:'no_review_keyframes'});continue;}
  // False-positive alarm does NOT mean wrong visual class. Each image needs its own annotation.
  for(const frame of row.review?.frames??[]){
   try{
    const response=await fetch(url+'/v1/alarms/'+encodeURIComponent(id)+'/review-frames/'+encodeURIComponent(frame.key),{headers,signal:AbortSignal.timeout(15000),redirect:'error'});
    if(!response.ok)throw Error('missing_image');
    const data=Buffer.from(await response.arrayBuffer());if(data.length>8*1024**2)throw Error('image_too_large');
    const filename=hash(data)+'.jpg';await writeFile(join(output,filename),data,{mode:0o600});
    const samples=row.analysis_evidence?.review_context?.samples??row.analysis_evidence?.review_context?.trace??[];
    const sample=samples.find(x=>x.frame_id===frame.frame_id);if(!sample)throw Error('missing_sample');
    items.push({id:id+':'+frame.key,group:row.channel_id+':'+row.stream_session_id+':'+row.track_ids?.[0],split:null,visual_label:null,image:filename,sha256:hash(data),row,sample});
   }catch{skipped.push({id,frame:frame.key,reason:'missing_or_expired_evidence'});}
  }
 }
 await writeFile(join(output,'manifest.json'),JSON.stringify({schema:'ainvr.review-dataset.v1',caller_template:REVIEW_PROMPT_VERSION,items,skipped},null,2),{mode:0o600});
 console.log(JSON.stringify({exported:items.length,skipped:skipped.length,instructions:'Annotate visual_label true/false and split development/test; keep each group in one split.'}));
}else{
 const manifest=JSON.parse(await readFile(input,'utf8')),items=manifest.items;
 if(manifest.caller_template!==REVIEW_PROMPT_VERSION||!Array.isArray(items)||!items.length||items.length>800)throw Error('Invalid dataset');
 const groups=new Map(),images=new Map();
 for(const x of items){
  if(typeof x.visual_label!=='boolean'||!['development','test'].includes(x.split)||typeof x.group!=='string'||!x.group)throw Error('Explicit visual annotations and splits required');
  for(const [map,key] of [[groups,x.group],[images,x.sha256]]){if(map.has(key)&&map.get(key)!==x.split)throw Error('Dataset leakage between splits');map.set(key,x.split);}
 }
 const cfg=await config('llm-service'),key=cfg.api_keys.find(k=>k.name==='alarm-review')?.key;if(!key)throw Error('Missing model caller');
 const report={schema:'ainvr.review-score.v1',caller_template:REVIEW_PROMPT_VERSION,manifest_sha256:hash(await readFile(input)),automatic_review_qualified:false,thresholds:{approve_above:.95,reject_below:.05,version:'frozen-v1'},results:[],errors:[]};
 await writeFile(output,JSON.stringify(report),{flag:'wx',mode:0o600});
 for(const x of items){
  try{
   const path=resolve(dirname(input),x.image);if(dirname(path)!==resolve(dirname(input)))throw Error('Image must be inside dataset directory');
   const data=await readFile(path);if(hash(data)!==x.sha256)throw Error('Image hash mismatch');
   const prompt=reviewDescription(x.row,x.sample),source=x.row.analysis_evidence.source,b=x.sample.bbox,r=x.row.rule.snapshot;
   const body={request_id:hash([x.id,REVIEW_PROMPT_VERSION,report.manifest_sha256].join(':')),image:{jpeg_base64:data.toString('base64'),fit:'letterbox'},preparation:{version:1,layout:'target-crop-v1',target:[b.x/source.width,b.y/source.height,(b.x+b.w)/source.width,(b.y+b.h)/source.height],region:r.points??[],approach_width_fraction:r.behavior==='region_approach'?r.approach_px/source.width:0},alarm:{kind:prompt.label,description:prompt.description}};
   const result=await json(`http://127.0.0.1:${cfg.listen.port}/v1/ainvr/tasks/alarm-review-zh-v1`,{Authorization:'Bearer '+key},body);
   if(result.prepared_image?.layout!=='target-crop-v1')throw Error('Unexpected model layout');
   if(!Number.isFinite(result.real_score)||result.real_score<0||result.real_score>1)throw Error('Invalid score');
   const {prepared_image,context_image,...score}=result;
   const imageHashes={};for(const [kind,image] of Object.entries({prepared_image,context_image}))if(image?.jpeg_base64){const bytes=Buffer.from(image.jpeg_base64,'base64');imageHashes[kind]=hash(bytes);await writeFile(output+'.'+hash(x.id).slice(0,16)+'.'+kind+'.jpg',bytes,{mode:0o600});}
   report.results.push({id:x.id,group:x.group,split:x.split,visual_label:x.visual_label,label:prompt.label,sha256:x.sha256,description:prompt.description,...score,imageHashes});
  }catch(e){report.errors.push({id:x.id,reason:e.message});}
  await writeFile(output,JSON.stringify(report,null,2),{mode:0o600});
 }
 console.log(JSON.stringify({scored:report.results.length,errors:report.errors.length,automatic_review_qualified:false}));
}
