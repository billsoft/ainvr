import {it,expect,vi,afterEach} from 'vitest';
import {AlarmRuleSync} from '../services/alarmRuleSync.js';
const connection={baseUrl:'http://127.0.0.1:29999',apiToken:'test-service-only-'.repeat(3),timeoutMs:1000};
afterEach(()=>vi.unstubAllGlobals());
it('reconciles before publishing and names blocked bindings without failing callers that need applied rules',async()=>{
 let revision='1';
 vi.stubGlobal('fetch',vi.fn(async(_:URL,init:RequestInit)=>{
  expect(revision).toBe('2');
  return Response.json(init.method==='POST'?{applied:true,revision,digest:'x'}:{state:'applied',revision,digest:'x'});
 }));
 const sync=new AlarmRuleSync({snapshot:async()=>({schema_version:'1.0',revision,rules:[]})},async()=>connection,async()=>{revision='2';return {updated:1,blocked:1}});
 expect(await sync.synchronize()).toMatchObject({state:'applied',applied_revision:'2',reason:expect.stringContaining('1 项')});
});
it('a failing catalog repair never stops rule publication, and repair runs at most once per interval',async()=>{
 const fetcher=vi.fn(async(_:URL,init:RequestInit)=>Response.json(init.method==='POST'?{applied:true,revision:'1',digest:'x'}:{state:'applied',revision:'1',digest:'x'}));
 vi.stubGlobal('fetch',fetcher);
 let clock=0;const reconcile=vi.fn(async()=>{throw Error('catalog unavailable');});
 const sync=new AlarmRuleSync({snapshot:async()=>({schema_version:'1.0',revision:'1',rules:[]})},async()=>connection,reconcile,{reconcileIntervalMs:60000,now:()=>clock});
 expect(await sync.synchronize()).toMatchObject({state:'applied'});
 expect(fetcher).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({method:'POST'}));
 clock=5000;await sync.synchronize();clock=59999;await sync.synchronize();
 expect(reconcile).toHaveBeenCalledTimes(1);
 // The last known blocked count survives a skipped or failed repair.
 reconcile.mockResolvedValueOnce({updated:0,blocked:2});clock=60000;
 expect((await sync.synchronize()).reason).toContain('2 项');
 clock=70000;expect((await sync.synchronize()).reason).toContain('2 项');
 reconcile.mockRejectedValueOnce(Error('offline'));clock=120000;
 expect(await sync.synchronize()).toMatchObject({state:'applied',reason:expect.stringContaining('2 项')});
});
it('confirms live revision and digest, catches concurrent configuration saves',async()=>{
  let desired='1',live='0';
  const fetcher=vi.fn(async(url:URL,init:RequestInit)=>{
    expect(url.pathname).toBe('/v1/configuration/rules');
    if(init.method==='POST'){
      live=JSON.parse(init.body as string).revision;
      if(live==='1')desired='2';
      return Response.json({applied:true,revision:live,digest:`hash-${live}`});
    }
    return Response.json({state:'applied',revision:live,digest:`hash-${live}`});
  });vi.stubGlobal('fetch',fetcher);
  const sync=new AlarmRuleSync({snapshot:async()=>({schema_version:'1.0',revision:desired,rules:[]})},async()=>connection);
  const result=await sync.synchronize();
  expect(result).toMatchObject({state:'applied',desired_revision:'2',applied_revision:'2'});
  expect(fetcher).toHaveBeenCalledTimes(4);
});
it('offline service or mismatched response never claims application and does not expose secrets',async()=>{
  const source={snapshot:async()=>({schema_version:'1.0',revision:'3',rules:[]})};
  vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('private-secret')}));
  const sync=new AlarmRuleSync(source,async()=>connection);
  expect(await sync.synchronize()).toMatchObject({state:'pending',desired_revision:'3'});
  expect(JSON.stringify(await sync.synchronize())).not.toContain('private-secret');
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({applied:true,revision:'2',digest:'wrong'})));
  expect((await sync.synchronize()).state).toBe('pending');
  expect((await new AlarmRuleSync(source,async()=>null).synchronize()).state).toBe('unavailable');
});
it('concurrent requests share one bounded synchronization instead of racing old snapshots',async()=>{
  const fetcher=vi.fn(async(_:URL,init:RequestInit)=>Response.json(init.method==='POST'?{applied:true,revision:'1',digest:'x'}:{state:'applied',revision:'1',digest:'x'}));
  vi.stubGlobal('fetch',fetcher);
  const sync=new AlarmRuleSync({snapshot:async()=>({schema_version:'1.0',revision:'1',rules:[]})},async()=>connection);
  const [a,b]=await Promise.all([sync.synchronize(),sync.synchronize()]);
  expect(a).toEqual(b);expect(fetcher).toHaveBeenCalledTimes(2);
});
