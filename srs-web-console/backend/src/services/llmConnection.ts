import type {PgConfigStore} from '../store/pgStore.js';
type Store=Pick<PgConfigStore,'getServiceState'|'getVersionSnapshotForService'|'getSecret'>;
export async function readAppliedLlmConnection(store:Store|null,host='host.docker.internal',caller='console-try'){
  if(!store)return null;
  if(!['127.0.0.1','localhost','host.docker.internal'].includes(host))throw Error('Invalid local service host');
  const state=await store.getServiceState('llm-service');
  if(!state?.appliedVersion)return null;
  const docs=await store.getVersionSnapshotForService(state.appliedVersion,'llm-service');
  const c=docs.find(d=>d.group==='system'&&d.name==='settings')?.config;
  if(!c)return null;
  async function resolve(value:unknown){
    if(typeof value!=='string')return null;
    const match=/^\$\{secret:(llm-service\/[a-zA-Z0-9_.\/-]+)\}$/.exec(value);
    return match?store!.getSecret(match[1]!):null;
  }
  const admin=await resolve(c.admin_key);
  const callers=Array.isArray(c.api_keys)?c.api_keys:[];
  const consoleKey=callers.find((v:unknown)=>!!v&&typeof v==='object'&&(v as {name?:string}).name===caller);
  const inference=await resolve(consoleKey?.key);
  const check=await store.getServiceState('llm-service');
  if(!admin||check?.appliedVersion!==state.appliedVersion)return null;
  const schedule=c.scheduling as Record<string,unknown>|undefined;
  const queue=Number(schedule?.queue_timeout_s??30), execution=Number(schedule?.exec_timeout_s??10);
  if(!Number.isInteger(queue)||queue<1||queue>300||!Number.isInteger(execution)||execution<1||execution>120)return null;
  return {inferenceTimeoutMs:(queue+execution+20)*1000,baseUrl:`http://${host}:8300`,admin,inference};
}
