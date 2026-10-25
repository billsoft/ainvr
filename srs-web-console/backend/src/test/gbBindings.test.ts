import Fastify from 'fastify';
import {describe,it,expect,vi} from 'vitest';
import {gb28181Routes} from '../routes/gb28181.js';
import type {GB28181Store} from '../store/gb28181Store.js';
describe('GB source mapping for unified channel editor',()=>{
 it('returns source identity only through authenticated management',async()=>{
  const query=vi.fn().mockResolvedValue({rows:[{input_id:'input',device_id:'device',channel_id:'channel'}]});
  const app=Fastify();await app.register(gb28181Routes,{store:{pg:{pool:{query}}} as unknown as GB28181Store,sync:null,principal:async()=> 'admin'});
  try{const r=await app.inject('/gb28181/bindings');expect(r.statusCode).toBe(200);expect(r.json()).toEqual({items:[{input_id:'input',device_id:'device',channel_id:'channel'}]});expect(query).toHaveBeenCalledOnce()}finally{await app.close()}
 });
 it('does not expose mappings before authentication',async()=>{
  const query=vi.fn();const app=Fastify();await app.register(gb28181Routes,{store:{pg:{pool:{query}}} as unknown as GB28181Store,sync:null,principal:async()=>null});
  try{expect((await app.inject('/gb28181/bindings')).statusCode).toBe(401);expect(query).not.toHaveBeenCalled()}finally{await app.close()}
 });
});
