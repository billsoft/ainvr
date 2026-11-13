import {endpoint,limitedJson,type AlarmConnection} from '../routes/alarmProxy.js';
interface Snapshot {schema_version:string;revision:string;rules:unknown[]}
interface Source {snapshot:()=>Promise<Snapshot>}
export interface RuleApplication {
  state:'applied'|'pending'|'unavailable';desired_revision:string|null;applied_revision:string|null
  checked_at:string;reason?:string
}
type Reconcile=()=>Promise<{updated:number;blocked:number}>;
// The live service is queried every time: cached success is not evidence after restart.
export class AlarmRuleSync {
  private running:Promise<RuleApplication>|null=null;
  private reconciledAt=-Infinity;private blocked=0;
  /** `reconcile` repairs bindings after a model catalog change. It reads every AI channel's catalog, so it runs at
   * most once per `reconcileIntervalMs` (the rule poll runs every few seconds), and it never stops rule publication:
   * a failed repair keeps the last known result and is retried on the next interval. */
  constructor(private source:Source,private connection:()=>Promise<AlarmConnection|null>,private reconcile?:Reconcile,
    private options:{reconcileIntervalMs?:number;now?:()=>number}={}){}
  synchronize():Promise<RuleApplication>{
    if(this.running)return this.running;
    this.running=this.apply().finally(()=>{this.running=null});return this.running;
  }
  private async exchange(config:AlarmConnection,method:'GET'|'POST',body?:Snapshot){
    const response=await fetch(endpoint(config,'/v1/configuration/rules'),{
      method,redirect:'error',signal:AbortSignal.timeout(config.timeoutMs),
      headers:{authorization:`Bearer ${config.apiToken}`,...(body?{'content-type':'application/json','x-ainvr-actor':'console-configuration'}:{})},
      body:body?JSON.stringify(body):undefined,
    });
    if(!response.ok)throw Error('Rule application not confirmed');
    return await limitedJson(response) as {state?:string;applied?:boolean;revision?:string;digest?:string};
  }
  private async apply():Promise<RuleApplication>{
    let desired:string|null=null,applied:string|null=null;
    const status=(state:RuleApplication['state'],reason?:string):RuleApplication=>({state,desired_revision:desired,applied_revision:applied,checked_at:new Date().toISOString(),...(reason?{reason}:{})});
    try{
      const config=await this.connection();
      if(!config)return status('unavailable','告警服务尚未配置');
      await this.repair();
      // A concurrent save may advance PG during the network round trip. Catch up boundedly.
      for(let attempt=0;attempt<3;attempt++){
        const snapshot=await this.source.snapshot();desired=snapshot.revision;
        const accepted=await this.exchange(config,'POST',snapshot);
        if(accepted.applied!==true||accepted.revision!==desired||typeof accepted.digest!=='string')return status('pending','服务尚未确认当前规则版本');
        const live=await this.exchange(config,'GET');applied=live.revision??null;
        const latest=await this.source.snapshot();desired=latest.revision;
        // Rules are applied even when some bindings could not follow a catalog change: those keep their old version and
        // are refused by the alarm service until re-armed. Report them without failing callers that need the rules applied.
        if(live.state==='applied'&&live.revision===desired&&live.digest===accepted.digest)return this.blocked?
          status('applied',`${this.blocked} 项布防或计数的来源已变化，请重新选择目标并布防`):status('applied');
      }
      return status('pending','配置正在变化，等待下一次同步');
    }catch{return status('pending','规则保存后尚未确认应用，将在服务恢复后重试');}
  }
  private async repair(){
    const now=(this.options.now??Date.now)();
    if(!this.reconcile||now-this.reconciledAt<(this.options.reconcileIntervalMs??60000))return;
    this.reconciledAt=now;
    try{this.blocked=(await this.reconcile()).blocked;}catch{/* keep the last result; the rules are still published */}
  }
}
