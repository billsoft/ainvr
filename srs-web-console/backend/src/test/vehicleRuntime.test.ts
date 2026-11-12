import {describe,it,expect,vi,afterEach} from 'vitest';
import {createHash} from 'node:crypto';
import {VehicleRuntime} from '../services/vehicleRuntime.js';
const conn=async()=>({baseUrl:'http://127.0.0.1:12345',apiToken:'a'.repeat(32),timeoutMs:30000});
function fixture(source:()=>Promise<{width:number;height:number}|null>){return new VehicleRuntime({read:async()=>({document:{requested:true}})} as never,{} as never,conn,conn,async()=>true,source);}
afterEach(()=>vi.unstubAllGlobals());
describe('vehicle runtime readiness boundaries',()=>{
 it('rejects known 8K before activation, accepts 4K, and leaves unknown video pending',async()=>{await expect(fixture(async()=>({width:7680,height:4320})).preflight('c')).rejects.toMatchObject({statusCode:422,code:'unsupported_image'});expect((await fixture(async()=>({width:3840,height:2160})).preflight('c')).state).toBe('supported');expect((await fixture(async()=>null).preflight('c')).state).toBe('awaiting_video');});
 it('retains structured busy, warmup and actual inference errors across BFF',async()=>{const jpeg=Buffer.from('original image'),meta={channel_id:'c',vehicle_roi:[0,0,100,100],expires_ms:Date.now()+30000,jpeg_sha256:createHash('sha256').update(jpeg).digest('hex')};for(const [status,code] of [[429,'vehicle_busy'],[503,'vehicle_not_ready'],[503,'vehicle_inference_failed']] as const){vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:{code}}),{status})));await expect(fixture(async()=>null).recognize(meta,jpeg)).rejects.toMatchObject({statusCode:status,code});}});
});

it('preserves retry error reasons instead of describing every 409 as a version conflict',async()=>{for(const [status,code] of [[409,'vehicle_disabled'],[409,'evidence_expired'],[429,'vehicle_busy'],[409,'version_conflict']] as const){vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:{code}}),{status})));await expect(fixture(async()=>null).alarmFetch('/v1/vehicles/id/retry','POST',{})).rejects.toMatchObject({statusCode:status,code});}});

it('keeps configured authorization when source verification temporarily returns unknown',async()=>{
 const runtime=new VehicleRuntime({requestedChannels:async()=>['c'],read:async()=>({version:0,document:{entries:[]}})} as never,{listCounters:async()=>[]} as never,conn,conn,async()=>true,async()=>null);
 Object.assign(runtime,{artifacts:async()=>[{state:'verified_file',sha256:'a'.repeat(64)},{state:'verified_file',sha256:'b'.repeat(64)}]});const messages:any[]=[];
 vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{messages.push(JSON.parse(init.body));return new Response(JSON.stringify({ready:true}));}));await runtime.sync();expect(messages[1].channels).toEqual([]);expect(messages[1].authorized_channels).toEqual(['c']);await runtime.close();
});

it('channel models override the obsolete vehicle switch',async()=>{
 const r=new VehicleRuntime({read:async()=>({document:{requested:true}})} as never,{} as never,conn,conn,async()=>true,async()=>null,async()=>[]);
 const jpeg=Buffer.from('original image'),meta={channel_id:'c',vehicle_roi:[0,0,100,100],expires_ms:Date.now()+30000,jpeg_sha256:createHash('sha256').update(jpeg).digest('hex')};
 expect(await r.configured('c')).toBe(false);await expect(r.recognize(meta,jpeg)).rejects.toThrow('vehicle_disabled');
});
