import {afterEach,expect,it,vi} from 'vitest';
import {GB28181Sync} from '../services/gb28181Sync.js';
import {defaultGBSettings} from '../store/gbSettings.js';

function fixture(){
 const id='34020000001320000001';
 const catalog=[{id:'34020000001320000002',name:'入口',status:'ON'}];
 const status={revision:1,ready:true,devices:[{id,generation:1,catalogComplete:true,catalog}]};
 const query=vi.fn(async()=>({rows:[]}));
 const client={query,release:vi.fn()};
 const store={readSettings:vi.fn(async()=>({revision:1,tokenSet:true,settings:defaultGBSettings})),devices:vi.fn(async()=>[{id,enabled:true,version:'2016'}]),pg:{getSecret:vi.fn(async()=> 'test-token-not-production'),pool:{query:vi.fn(async()=>({rows:[]})),connect:vi.fn(async()=>client)}}};
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(JSON.stringify(url.endsWith('/v1/status')?status:{}))));
 const sync=new GB28181Sync(store as never,{} as never);
 return {sync,store,status,query};
}
afterEach(()=>vi.unstubAllGlobals());
it('unchanged complete catalogs do not rewrite the database on each poll',async()=>{
 const {sync,store,status,query}=fixture();
 await sync.synchronize();await sync.synchronize();
 expect(store.pg.pool.connect).toHaveBeenCalledTimes(1);
 expect(query.mock.calls.some(([sql])=>String(sql).includes('jsonb_array_elements'))).toBe(true);
 status.devices[0].catalog[0].name='新入口';await sync.synchronize();
 expect(store.pg.pool.connect).toHaveBeenCalledTimes(2);
});

it('disabled stale bindings do not rewrite repurposed inputs or block gateway synchronization',async()=>{
 const {store}=fixture();
 const config={name:'old GB source',description:'',protocols:['flv'],primary:'flv'};
 store.pg.pool.query.mockResolvedValue({rows:[{binding_id:'old',input_id:'input',stream_name:'gb_old',enabled:false,channel_config:config}] } as never);
 const channels={listChannels:vi.fn(async()=>[{id:'input',streamName:'ordinary_camera',upstreamProtocol:'rtmp'}]),updateChannel:vi.fn()};
 const sync=new GB28181Sync(store as never,channels as never);
 await sync.synchronize();
 expect(channels.updateChannel).not.toHaveBeenCalled();
 expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/v1/config'),expect.anything());
 expect(sync.status().state).toBe('disabled');
});

it('a stale input snapshot cannot disable a concurrently edited binding',async()=>{
 const {store,query}=fixture();
 store.pg.pool.query.mockResolvedValue({rows:[{binding_id:'old',input_id:'missing',enabled:true}]} as never);
 query.mockImplementation(async(sql?:string)=>({rows:sql?.includes('FOR UPDATE')?[{revision:2}]:[]}) as never);
 const sync=new GB28181Sync(store as never,{listChannels:vi.fn(async()=>[])} as never);
 await sync.synchronize();
 expect(query.mock.calls.some(([sql])=>String(sql).startsWith('UPDATE gb28181_bindings'))).toBe(false);
 expect(query).toHaveBeenCalledWith('ROLLBACK');
 expect(fetch).not.toHaveBeenCalled();
});
it('failed catalog transactions remain retryable and incomplete catalogs preserve history',async()=>{
 const {sync,store,status,query}=fixture();
 query.mockRejectedValueOnce(new Error('database unavailable'));
 await sync.synchronize();expect(sync.status().state).toBe('unavailable');
 await sync.synchronize();expect(store.pg.pool.connect).toHaveBeenCalledTimes(2);
 status.devices[0].catalogComplete=false;status.devices[0].catalog=[];
 await sync.synchronize();expect(store.pg.pool.connect).toHaveBeenCalledTimes(2);
});
it('a new device generation persists its directory even when names are unchanged',async()=>{
 const {sync,store,status}=fixture();
 await sync.synchronize();status.devices[0].generation++;
 await sync.synchronize();expect(store.pg.pool.connect).toHaveBeenCalledTimes(2);
});

it('saved channel metadata is applied without a configured gateway and retried after failure',async()=>{
 const config={name:'甲板入口',description:'测试备注',protocols:['hls'],primary:'hls'};
 const binding={binding_id:'binding',device_id:'device',channel_id:'channel',stream_name:'gb_stream',input_id:'input',enabled:true,channel_config:config,applied_config:null};
 const query=vi.fn(async(sql:string)=>({rows:sql.startsWith('SELECT b.*')?[binding]:[]}));
 const store={readSettings:vi.fn(async()=>({revision:1,tokenSet:false,settings:defaultGBSettings})),devices:vi.fn(async()=>[]),pg:{getSecret:vi.fn(),pool:{query}}};
 const channels={listChannels:vi.fn(async()=>[{id:'input',streamName:'gb_stream',app:'live',upstreamProtocol:'rtmp'}]),updateChannel:vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue({})};
 const sync=new GB28181Sync(store as never,channels as never);
 await sync.synchronize();expect(sync.status().state).toBe('unavailable');
 expect(query.mock.calls.some(([sql])=>sql.includes('SET applied_config'))).toBe(false);
 await sync.synchronize();expect(sync.status().state).toBe('waiting_configuration');
 expect(channels.updateChannel).toHaveBeenLastCalledWith('input',{name:config.name,remark:config.description,downstreamProtocols:['hls'],primaryProtocol:'hls'});
 expect(query.mock.calls.some(([sql])=>sql.includes('AND channel_config=$1'))).toBe(true);
});
