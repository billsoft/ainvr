import {describe,it,expect,vi} from 'vitest';
import Fastify from 'fastify';
import {vehicleRoutes} from '../routes/vehicleRoutes.js';
import {vehicleOnly,watchlistSchema,VehiclePreparation} from '../store/vehiclePreparation.js';
import {AlarmConfigError} from '../store/alarmZones.js';

async function fixture(login=true){
  const app=Fastify(),save=vi.fn(async(_key,version,document)=>({version:version+1,document}));
  const counters=[{counter_id:'cars',labels:[{name:'car',label_id:'car'}]}, {counter_id:'mixed',labels:[{name:'car',label_id:'car'},{name:'person',label_id:'person'}]},{counter_id:'changed',labels:[{name:'car',label_id:'car'}]}];
  await app.register(vehicleRoutes,{principal:async()=>login?'operator':null,store:{read:async()=>({version:0,document:{requested:false}}),save},channelExists:async id=>id==='camera',arming:{listCounters:async()=>counters,definitionHistory:async()=>[{counter_id:'cars',labels:[{label_id:'car'}]},{counter_id:'changed',labels:[{label_id:'person'}]}]} as never});
  return {app,save};
}
describe('vehicle integration boundaries',()=>{
  it('requires existing console authentication',async()=>{const {app,save}=await fixture(false);try{expect((await app.inject('/vehicle/capabilities')).statusCode).toBe(401);expect(save).not.toHaveBeenCalled()}finally{await app.close()}});
  it('persists configuration but reports unavailable when no runtime is registered',async()=>{const {app,save}=await fixture();try{const r=await app.inject({method:'PUT',url:'/vehicle/channels/camera',payload:{expected_version:0,document:{requested:true}}});expect(r.statusCode).toBe(200);expect(r.json().capability.effective).toBe(false);expect(r.json().capability.blockers).toContain('runtime_unavailable');expect(save).toHaveBeenCalledWith('channel:camera',0,{requested:true},'operator')}finally{await app.close()}});
  it('rejects unknown channel and injected runtime fields',async()=>{const {app,save}=await fixture();try{expect((await app.inject({method:'PUT',url:'/vehicle/channels/missing',payload:{expected_version:0,document:{requested:true}}})).statusCode).toBe(404);expect((await app.inject({method:'PUT',url:'/vehicle/channels/camera',payload:{expected_version:0,document:{requested:true,effective:true}}})).statusCode).toBe(422);expect(save).not.toHaveBeenCalled()}finally{await app.close()}});
  it('normalizes plate names and rejects duplicate or unsupported formats',()=>{expect(watchlistSchema.parse({entries:[{plate:' 京a12345 ',note:' x '}]}).entries[0]).toEqual({plate:'京A12345',note:'x'});expect(watchlistSchema.safeParse({entries:[{plate:'京a12345',note:''},{plate:'京A12345',note:''}]}).success).toBe(false);expect(watchlistSchema.safeParse({entries:[{plate:'unknown',note:''}]}).success).toBe(false)});
  it('excludes mixed classes and counters with past nonvehicle labels',async()=>{const {app}=await fixture();try{const r=await app.inject('/vehicle/counters');expect(r.statusCode).toBe(200);expect(r.json().items.map((c:{counter_id:string})=>c.counter_id)).toEqual(['cars'])}finally{await app.close()}});
  it('supports declared special suffix plates without accepting arbitrary Han characters',()=>{for(const plate of ['粤Z1234港','粤Z1234澳','京A1234学','京A1234警','冀A1234挂'])expect(watchlistSchema.safeParse({entries:[{plate,note:''}]}).success).toBe(true);expect(watchlistSchema.safeParse({entries:[{plate:'人A12345',note:''}]}).success).toBe(false);});
  it('does not guess unknown classes',()=>{expect(vehicleOnly([])).toBe(false);expect(vehicleOnly([{name:'person'}])).toBe(false);expect(vehicleOnly([{name:'car'},{name:'bus'}])).toBe(true)});
  it('propagates optimistic version conflicts',async()=>{const {app,save}=await fixture();save.mockRejectedValueOnce(new AlarmConfigError('version_conflict','请重新载入',409));try{expect((await app.inject({method:'PUT',url:'/vehicle/watchlist',payload:{expected_version:1,document:{entries:[]}}})).statusCode).toBe(409)}finally{await app.close()}});
  it('never overwrites an existing row using version zero',async()=>{const query=vi.fn(async()=>({rows:[]})),store=new VehiclePreparation({query} as never);await expect(store.save('watchlist',0,{entries:[]},'operator')).rejects.toMatchObject({statusCode:409});expect(query).toHaveBeenCalledTimes(1);expect(query.mock.calls[0][0]).toContain('DO NOTHING')});
});
