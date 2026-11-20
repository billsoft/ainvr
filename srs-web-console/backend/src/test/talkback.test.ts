import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { talkbackRoutes } from '../routes/talkback.js';
import { GB28181Sync } from '../services/gb28181Sync.js';
describe('camera talkback leases', () => {
  it('uses the configured GB session and treats an already released gateway session as stopped', async () => {
    const session='f'.repeat(32);
    const store={readSettings:async()=>({settings:{enabled:true,gatewayUrl:'http://127.0.0.1:9990'}}),
      pg:{getSecret:async()=> 'test-token'}};
    const client=new GB28181Sync(store as never,{} as never);
    const wire=vi.spyOn(globalThis,'fetch')
      .mockResolvedValueOnce(Response.json({session})).mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(new Response('expired',{status:410}))
      .mockResolvedValueOnce(new Response('x'.repeat(4097)));
    try {
      const sink=await client.broadcastSink('binding',new AbortController().signal);
      await sink.write(Buffer.alloc(3200));
      await expect(sink.close()).resolves.toBeUndefined();
      expect(wire.mock.calls.map(([url])=>url)).toEqual(['start','audio','stop'].map(a=>'http://127.0.0.1:9990/v1/broadcast/'+a));
      expect(JSON.parse(wire.mock.calls[2]![1]!.body as string)).toEqual({session});
      await expect(client.broadcastSink('binding',new AbortController().signal)).rejects.toThrow('Response too large');
    } finally { wire.mockRestore(); }
  });
  it('rejects expired audio before the sweeper and reserves the speaker until close finishes', async () => {
    const app = Fastify(), closed = Promise.withResolvers<void>();
    const sink = {close:vi.fn(() => closed.promise),write:vi.fn(async () => {})};
    await app.register(talkbackRoutes,{principal:async () => 'operator',open:async () => sink});
    const now = vi.spyOn(Date,'now');
    const url='/talkback/channels/00000000-0000-4000-8000-000000000001';
    try {
      now.mockReturnValue(1000);
      const {session} = (await app.inject({method:'POST',url})).json();
      now.mockReturnValue(6000);
      const chunk = await app.inject({method:'POST',url:'/talkback/'+session+'/audio/0',
        headers:{'content-type':'application/octet-stream'},payload:Buffer.alloc(3200)});
      expect(chunk.statusCode).toBe(410);
      expect(sink.write).not.toHaveBeenCalled();
      expect((await app.inject({method:'POST',url})).statusCode).toBe(409);
      closed.resolve();
      await new Promise(resolve=>setImmediate(resolve));
      expect((await app.inject({method:'POST',url})).statusCode).toBe(200);
      expect(sink.close).toHaveBeenCalledTimes(1);
    } finally { closed.resolve(); now.mockRestore(); await app.close(); }
  });
  it('closes a revoked source before writing the next audio block',async () => {
    const app=Fastify(),sink={current:vi.fn(async()=>false),write:vi.fn(),close:vi.fn()};
    await app.register(talkbackRoutes,{principal:async ()=>'operator',open:async ()=>sink});
    try {
      const {session}=(await app.inject({method:'POST',url:'/talkback/channels/00000000-0000-4000-8000-000000000001'})).json();
      const res=await app.inject({method:'POST',url:'/talkback/'+session+'/audio/0',
        headers:{'content-type':'application/octet-stream'},payload:Buffer.alloc(3200)});
      expect(res.statusCode).toBe(410);
      expect(sink.write).not.toHaveBeenCalled();
      expect(sink.close).toHaveBeenCalledTimes(1);
    } finally {await app.close();}
  });
  it('discards a write completing after Stop without touching the next session', async () => {
    const app=Fastify(), written=Promise.withResolvers<void>(), started=Promise.withResolvers<void>();
    const old={write:vi.fn(() => {started.resolve();return written.promise;}),close:vi.fn()};
    const next={write:vi.fn(),close:vi.fn()};
    await app.register(talkbackRoutes,{principal:async () => 'operator',open:vi.fn().mockResolvedValueOnce(old).mockResolvedValue(next)});
    const url='/talkback/channels/00000000-0000-4000-8000-000000000001';
    try {
      const {session}=(await app.inject({method:'POST',url})).json();
      const inFlight=app.inject({method:'POST',url:'/talkback/'+session+'/audio/0',
        headers:{'content-type':'application/octet-stream'},payload:Buffer.alloc(3200)}).then(r=>r.statusCode);
      await started.promise;
      expect((await app.inject({method:'DELETE',url:'/talkback/'+session})).statusCode).toBe(204);
      expect((await app.inject({method:'POST',url})).statusCode).toBe(200);
      written.resolve();
      expect(await inFlight).toBe(410);
      expect(old.close).toHaveBeenCalledTimes(1);
      expect(next.close).not.toHaveBeenCalled();
    } finally { written.resolve(); await app.close(); }
  });
  it('requires a principal, serializes sessions and frames, releases the sink', async () => {
    const app = Fastify();
    const sink = {close:vi.fn(), write:vi.fn(async () => {})};
    await app.register(talkbackRoutes, {principal:async req => typeof req.headers.actor === 'string' ? req.headers.actor : null, open:async () => sink});
    try {
      const url='/talkback/channels/00000000-0000-4000-8000-000000000001';
      expect((await app.inject({method:'POST',url})).statusCode).toBe(401);
      const headers={actor:'operator'};
      const first=await app.inject({method:'POST',url,headers});
      expect(first.statusCode).toBe(200);
      expect((await app.inject({method:'POST',url,headers})).statusCode).toBe(409);
      const path='/talkback/'+first.json().session;
      const audio=(seq:number,size:number,actor='operator') =>app.inject({method:'POST',url:path+'/audio/'+seq,headers:{actor,'content-type':'application/octet-stream'},payload:Buffer.alloc(size)});
      expect((await audio(0,3200,'other')).statusCode).toBe(410);
      expect((await audio(0,100)).statusCode).toBe(400);
      expect((await audio(1,3200)).statusCode).toBe(409);
      expect((await audio(0,3200)).statusCode).toBe(204);
      expect((await audio(0,3200)).statusCode).toBe(409);
      expect(sink.write).toHaveBeenCalledTimes(1);
      expect((await app.inject({method:'DELETE',url:path,headers})).statusCode).toBe(204);
      expect(sink.close).toHaveBeenCalledTimes(1);
      expect((await audio(1,3200)).statusCode).toBe(410);
    } finally {await app.close();}
  });
});
