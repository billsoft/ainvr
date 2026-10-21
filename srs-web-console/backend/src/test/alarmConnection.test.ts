import {it,expect,vi} from 'vitest';
import {readAppliedAlarmConnection} from '../services/alarmConnection.js';
import {sanitizeImportDocSecrets} from '../routes/configPolicy.js';
it('reads the applied snapshot and its version-specific key, never desired draft values',async()=>{
  const state=vi.fn(async()=>({appliedVersion:2,desiredVersion:3}));
  const docs=vi.fn(async()=>[{group:'system',name:'settings',config:{port:8200,api_token:'${secret:alarm-service/api_token/revision-two}'}}]);
  const secret=vi.fn(async()=> 'private-service-key-'.repeat(3));
  const result=await readAppliedAlarmConnection({getServiceState:state,getVersionSnapshotForService:docs,getSecret:secret} as never,'127.0.0.1');
  expect(result?.baseUrl).toBe('http://127.0.0.1:8200');expect(docs).toHaveBeenCalledWith(2,'alarm-service');
  expect(secret).toHaveBeenCalledWith('alarm-service/api_token/revision-two');
  state.mockResolvedValueOnce({appliedVersion:2,desiredVersion:3}).mockResolvedValueOnce({appliedVersion:3,desiredVersion:3});
  expect(await readAppliedAlarmConnection({getServiceState:state,getVersionSnapshotForService:docs,getSecret:secret} as never)).toBeNull();
});
it('each alarm secret update retains prior references for rollback',async()=>{
  const values=new Map<string,string>();
  const store={setSecret:async(k:string,v:string)=>{values.set(k,v)}};
  const first=await sanitizeImportDocSecrets('alarm-service',{api_token:'first-secret'},store as never,'operator');
  const second=await sanitizeImportDocSecrets('alarm-service',{api_token:'second-secret'},store as never,'operator');
  expect(first.api_token).not.toBe(second.api_token);expect(values.size).toBe(2);
  expect([...values.values()]).toEqual(['first-secret','second-secret']);
  const preserved=await sanitizeImportDocSecrets('alarm-service',first,store as never,'operator');expect(preserved).toEqual(first);expect(values.size).toBe(2);
});
