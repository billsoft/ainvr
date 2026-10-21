import type {PgConfigStore} from '../store/pgStore.js';
import {endpoint,type AlarmConnection} from '../routes/alarmProxy.js';
type Store=Pick<PgConfigStore,'getServiceState'|'getVersionSnapshotForService'|'getSecret'>;
export async function readAppliedAlarmConnection(store:Store|null,host='host.docker.internal'):Promise<AlarmConnection|null>{
  if(!store)return null;
  const state=await store.getServiceState('alarm-service');
  if(!state?.appliedVersion)return null;
  const docs=await store.getVersionSnapshotForService(state.appliedVersion,'alarm-service');
  const doc=docs.find(d=>d.group==='system'&&d.name==='settings');
  if(!doc)return null;
  const port=doc.config.port,ref=doc.config.api_token;
  if(!Number.isInteger(port)||Number(port)<1024||Number(port)>65535||typeof ref!=='string')return null;
  const match=/^\$\{secret:(alarm-service\/api_token(?:\/[a-zA-Z0-9_-]+)?)\}$/.exec(ref);
  if(!match)return null; // No browser plaintext or cross-service secret fallback.
  const token=await store.getSecret(match[1]);if(!token)return null;
  const check=await store.getServiceState('alarm-service');
  if(check?.appliedVersion!==state.appliedVersion)return null;
  const connection={baseUrl:`http://${host}:${port}`,apiToken:token,timeoutMs:5000};
  endpoint(connection,'/v1/status');return connection;
}
