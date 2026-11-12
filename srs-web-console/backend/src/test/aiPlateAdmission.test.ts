import Fastify from 'fastify';
import {describe,it,expect,vi,afterEach} from 'vitest';
import {aiProxyRoutes} from '../routes/aiProxy.js';
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});
async function fixture(width?:number,height?:number){
 const calls:string[]=[];
 globalThis.fetch=vi.fn(async (url:any,opts:any)=>{
   calls.push(opts?.method??'GET');
   return new Response(JSON.stringify(opts?.method?{applied:true}:{config:{model:{adapter:'plate_bpu'},stream:{url:'rtmp://127.0.0.1/live/source'}}}),{status:200,headers:{'Content-Type':'application/json'}});
 }) as any;
 const app=Fastify();await app.register(aiProxyRoutes,{fallbackBaseUrl:'http://127.0.0.1:8000',settingsStore:{read:async()=>({aiService:{baseUrl:'',apiKey:''}})} as any,srsClient:{listStreams:async()=>width?[{app:'live',name:'source',video:{width,height}}]:[]} as any});
 return {app,calls};
}
describe('plate source admission in shared channel mutations',()=>{
 it('rejects known 8K before creating a channel',async()=>{const {app,calls}=await fixture(7680,4320);try{const r=await app.inject({method:'POST',url:'/ai/channels',payload:{model:{adapter:'plate_bpu'},stream:{url:'rtmp://127.0.0.1/live/source'}}});expect(r.statusCode).toBe(422);expect(calls).toEqual([]);}finally{await app.close();}});
 it('rejects enabling an additional plate node and changing an existing plate source',async()=>{const {app,calls}=await fixture(7680,4320);try{for(const payload of [{analysis_pipeline:{nodes:[{model:{adapter:'plate_bpu'}}]}},{stream:{url:'rtmp://127.0.0.1/live/source'}}]){const r=await app.inject({method:'PUT',url:'/ai/channels/a/config',payload});expect(r.statusCode).toBe(422);}expect(calls).toEqual(['GET','GET']);}finally{await app.close();}});
 it('allows removing plate even while source is unsupported',async()=>{const {app,calls}=await fixture(7680,4320);try{const r=await app.inject({method:'PUT',url:'/ai/channels/a/config',payload:{model:{adapter:'yolo26_bpu'},analysis_pipeline:{nodes:[]}}});expect(r.statusCode).toBe(200);expect(calls).toEqual(['GET','PUT']);}finally{await app.close();}});
 it.each([[3840,2160],[undefined,undefined]])('allows 4K or unknown input; native validates incoming frames',async(w,h)=>{const {app,calls}=await fixture(w,h);try{const r=await app.inject({method:'POST',url:'/ai/channels',payload:{model:{adapter:'plate_bpu'},stream:{url:'rtmp://127.0.0.1/live/source'}}});expect(r.statusCode).toBe(200);expect(calls).toEqual(['POST']);}finally{await app.close();}});
});
