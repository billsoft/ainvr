import {stat,readFile} from 'node:fs/promises';
import {validateConfig,startService} from './runtime.mjs';

export function validateBootstrap(input){
  if(!input||Object.keys(input).some(k=>!['control_url','service_token','poll_ms'].includes(k)))throw Error('Invalid configuration bootstrap');
  const url=new URL(input.control_url);
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]','host.docker.internal'].includes(url.hostname)||!url.port||url.pathname!=='/'||url.username||url.password||url.search||url.hash)throw Error('Local configuration endpoint required');
  if(typeof input.service_token!=='string'||input.service_token.length<32||input.service_token.length>512)throw Error('Dedicated configuration credential required');
  if(!Number.isInteger(input.poll_ms)||input.poll_ms<1000||input.poll_ms>60000)throw Error('Invalid polling interval');
  return {...input};
}
export async function loadBootstrap(path){
  const info=await stat(path);
  if(!info.isFile()||info.size>65536||(process.platform!=='win32'&&(info.mode&0o077)!==0))throw Error('Private bootstrap required');
  return validateBootstrap(JSON.parse(await readFile(path,'utf8')));
}
export function createConfigTransport(bootstrap){
  return async(path,body)=>{
    const response=await fetch(new URL(`/api/v1/config/${path}`,bootstrap.control_url),{
      method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{'x-service-token':bootstrap.service_token,...(body?{'content-type':'application/json'}:{})},
      body:body?JSON.stringify(body):undefined,
    });
    if(!response.ok)throw Error('Configuration center unavailable');
    const reader=response.body?.getReader();if(!reader)throw Error('Empty configuration response');
    const chunks=[];let total=0;
    try{while(true){const part=await reader.read();if(part.done)break;total+=part.value.length;if(total>1024*1024)throw Error('Configuration response too large');chunks.push(part.value);}}
    finally{await reader.cancel().catch(()=>{});}
    const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(result.code!==0)throw Error('Configuration request failed');return result.data;
  };
}

export class ConfigCenterController {
  constructor({request,start=startService,evidenceSource,reviewInvoke,recoverEvidence}){this.request=request;this.start=start;this.evidenceSource=evidenceSource;this.reviewInvoke=reviewInvoke;this.recoverEvidence=recoverEvidence;this.active=null;this.config=null;this.inFlight=null;this.stopping=false;this.timer=null;}
  tick(){
    if(this.stopping)return Promise.resolve();
    if(this.inFlight)return this.inFlight;
    this.inFlight=this.applyDesired().finally(()=>{this.inFlight=null});return this.inFlight;
  }
  async report(status,errorMessage){
    await this.request('service-states/alarm-service',{
      ...(this.active&&this.config?{appliedVersion:this.config.version}:{}),status,restartRequired:false,
      ...(errorMessage?{errorMessage}:{errorMessage:''}),
    });
  }
  async applyDesired(){
    try{
      const state=await this.request('service-states/alarm-service');
      const desired=state?.desiredVersion;
      if(!Number.isSafeInteger(desired)||desired<1)return;
      if(this.active&&this.config?.version===desired){await this.report('applied');return;}
      const docs=await this.request(`versions/${desired}/snapshot?service=alarm-service`);
      if(!Array.isArray(docs)||docs.length!==1||docs[0].service!=='alarm-service'||docs[0].group!=='system'||docs[0].name!=='settings')throw Error('Invalid service snapshot');
      const next=validateConfig({...docs[0].config,schema_version:'1.0',version:desired,operation_id:`config-${desired}`});
      // Validate before touching a running listener. A bad document leaves it intact.
      if(this.stopping)return;
      const previous=this.config;
      if(this.active){await this.active.close();this.active=null;}
      try{this.active=await this.start(next,{evidenceSource:this.evidenceSource,reviewInvoke:this.reviewInvoke,recoverEvidence:this.recoverEvidence});this.config=next;}
      catch{
        // Roll back only this service, not the recorder, AI or media services.
        if(previous&&!this.stopping){try{this.active=await this.start(previous,{evidenceSource:this.evidenceSource,reviewInvoke:this.reviewInvoke,recoverEvidence:this.recoverEvidence});this.config=previous;}catch{this.active=null;}}
        throw Error('New configuration could not start');
      }
      if(!this.stopping)await this.report('applied');
    }catch{
      if(!this.stopping)await this.report('failed','告警服务配置未应用；请检查参数、数据库或监听端口').catch(()=>{});
    }
  }
  run(interval){
    const poll=async()=>{await this.tick();if(!this.stopping)this.timer=setTimeout(poll,interval);};
    void poll();
  }
  async close(){
    this.stopping=true;clearTimeout(this.timer);await this.inFlight;
    if(this.active){await this.active.close();this.active=null;}
  }
}
