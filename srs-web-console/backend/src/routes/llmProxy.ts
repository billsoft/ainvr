import type {FastifyInstance,FastifyRequest} from 'fastify';
import {limitedJson} from '../services/internalServiceHttp.js';
interface Options {
  recordingConnection?:()=>Promise<{baseUrl:string;token:string}>;
  alarmConnection?:()=>Promise<{baseUrl:string;apiToken:string}|null>;
  internalPrincipal?:(request:FastifyRequest)=>Promise<boolean>;
  reviewConnection?:Options['connection'];
  principal:(request:FastifyRequest)=>Promise<string|null>;
  connection:()=>Promise<{baseUrl:string;admin:string;inference:string|null;inferenceTimeoutMs?:number}|null>;
}
export async function llmProxyRoutes(app:FastifyInstance,options:Options){
  app.get('/alarms/events/:id/review-frames/:key',async(req,reply)=>{
    if(!await options.principal(req))return reply.code(401).send({error:{code:'unauthorized'}});
    const {id,key}=req.params as {id:string;key:string};
    if(!/^[a-zA-Z0-9_:.-]{1,256}$/.test(id)||!/^[a-f0-9]{64}$/.test(key))return reply.code(422).send({error:{code:'invalid_evidence'}});
    try{
      const c=await options.alarmConnection?.();if(!c)throw Error();
      const response=await fetch(new URL(`/v1/alarms/${encodeURIComponent(id)}/review-frames/${key}`,c.baseUrl),{headers:{authorization:`Bearer ${c.apiToken}`},redirect:'error',signal:AbortSignal.timeout(10000)});
      if(!response.ok||!response.body)throw Error();
      const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
      try{while(true){const x=await reader.read();if(x.done)break;size+=x.value.length;if(size>8*1024*1024)throw Error();parts.push(x.value)}}finally{await reader.cancel().catch(()=>{})}
      return reply.header('Cache-Control','private, no-store').send({jpeg_base64:Buffer.concat(parts).toString('base64')});
    }catch{return reply.code(404).send({error:{code:'missing_context'}});}
  });
  app.post('/internal/alarm-recording-evidence',{bodyLimit:8192},async(req,reply)=>{
    if(!await options.internalPrincipal?.(req))return reply.code(403).send({error:{code:'unauthorized'}});
    try{
      const c=await options.recordingConnection?.();if(!c?.token)throw Error();
      const target=new URL('/v1/recordings/recover-evidence',c.baseUrl);
      const response=await fetch(target,{method:'POST',redirect:'error',signal:AbortSignal.timeout(35000),headers:{'x-service-token':c.token,'content-type':'application/json'},body:JSON.stringify(req.body)});
      return reply.code(response.status).send(await limitedJson(response));
    }catch{return reply.code(503).send({error:{code:'recording_evidence_unavailable'}});}
  });
  app.post('/internal/alarm-review',{bodyLimit:12*1024*1024+16384},async(req,reply)=>{
    if(!await options.internalPrincipal?.(req))return reply.code(403).send({error:{code:'unauthorized'}});
    // Coordinates and detector claims cannot substitute for visual category evidence.
    // The model remains authoritative for JPEG decoding and its own input contract.
    const body=req.body as {image?:{jpeg_base64?:unknown};alarm?:{kind?:unknown;description?:unknown}}|null;
    if(!body||typeof body.image?.jpeg_base64!=='string'||body.image.jpeg_base64.length<8||
      typeof body.alarm?.kind!=='string'||!body.alarm.kind.trim()||body.alarm.kind.length>128||
      typeof body.alarm.description!=='string'||!body.alarm.description.trim()||Buffer.byteLength(body.alarm.description)>8192)
      return reply.code(422).send({error:{code:'invalid_alarm_evidence',message:'审核需要真实图片和目标类别；文字或坐标不能代替图片'}});
    try{
      const c=await options.reviewConnection?.();if(!c?.inference)return reply.code(503).send({error:{code:'review_not_configured'}});
      const target=new URL('/v1/ainvr/tasks/alarm-review-zh-v1',c.baseUrl);
      if(target.protocol!=='http:'||!['127.0.0.1','localhost','host.docker.internal'].includes(target.hostname)||target.port!=='8300')throw Error('Invalid target');
      const response=await fetch(target,{method:'POST',redirect:'error',signal:AbortSignal.timeout(Math.min(c.inferenceTimeoutMs??60000,440000)),
        headers:{authorization:`Bearer ${c.inference}`,'content-type':'application/json'},body:JSON.stringify(req.body)});
      return reply.code(response.status).send(await limitedJson(response));
    }catch{return reply.code(503).send({error:{code:'review_unavailable'}});}
  });
  for(const [method,route,path] of [
    ['GET','/llm/status','/v1/status'],['GET','/llm/models','/v1/models'],
    ['POST','/llm/admin/load','/v1/admin/load'],['POST','/llm/admin/unload','/v1/admin/unload'],
    ['POST','/llm/try','/v1/ainvr/tasks/alarm-review-zh-v1'],
  ] as const){
    app.route({method,url:route,bodyLimit:12*1024*1024+16384,handler:async(req,reply)=>{
      if(!await options.principal(req))return reply.code(401).send({error:{code:'unauthorized',message:'需要登录'}});
      try{
        const connection=await options.connection();
        if(!connection)return reply.code(503).send({error:{code:'llm_not_configured',message:'大模型服务尚未配置或配置尚未应用'}});
        const target=new URL(path,connection.baseUrl);
        if(target.protocol!=='http:'||!['127.0.0.1','localhost','host.docker.internal'].includes(target.hostname)||target.port!=='8300')throw Error('Invalid local target');
        const inference=route==='/llm/try',key=inference?connection.inference:connection.admin;
        if(!key)return reply.code(503).send({error:{code:'console_key_missing',message:'请先配置 console-try 调用方密钥'}});
        const response=await fetch(target,{method,redirect:'error',signal:AbortSignal.timeout(inference?Math.min(connection.inferenceTimeoutMs??60000,440000):10000),
          headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},
          body:method==='POST'?JSON.stringify(req.body??{}):undefined});
        if(response.status===401||response.status===403)throw Error('Service authentication failed');
        const result=await limitedJson(response);return reply.code(response.status).send(result);
      }catch{return reply.code(502).send({error:{code:'llm_unavailable',message:'大模型服务暂不可用，请检查服务状态'}});}
    }});
  }
}
