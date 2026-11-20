import { GBError } from '../store/gb28181Store.js';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export interface AudioSink {
  current?(): Promise<boolean>;
  write(pcm: Buffer): Promise<void>;
  close(): void | Promise<void>;
}
export class TalkError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const unsupported = () => new TalkError(422, '设备未开放可用的音频回传轨道，或不支持当前编码');

export async function onvifSink(source: string, signal: AbortSignal): Promise<AudioSink> {
  signal.throwIfAborted();
  const uri = new URL(source);
  const credentials = [decodeURIComponent(uri.username), decodeURIComponent(uri.password)];
  uri.username = uri.password = '';
  const helper = fileURLToPath(new URL(import.meta.url.endsWith('.ts')
    ? '../../helpers/onvif_audio.py' : '../helpers/onvif_audio.py', import.meta.url));
  const child = spawn('/usr/bin/python3', [helper], { stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  let closed = false;
  function close() {
    if (closed) return exited;
    closed = true;
    child.stdin.end();
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 1200);
    timer.unref();
    child.once('exit', () => clearTimeout(timer));
    return exited;
  }
  signal.addEventListener('abort', close, { once: true });
  child.stdin.on('error', close);
  const lines = createInterface({ input: child.stdout });
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = () => reject(new TalkError(503, '摄像头音频连接未建立'));
      child.once('error', fail);
      child.once('close', () => { closed = true; signal.removeEventListener('abort', close); fail(); });
      lines.once('line', line => line === 'ready' ? resolve() :
        reject(line === 'backchannel_unavailable' ? unsupported() : new TalkError(503, '摄像头拒绝或未完成音频协商')));
      child.stdin.write(JSON.stringify([uri.toString(), ...credentials]) + '\n');
    });
    signal.throwIfAborted();
    return {
      close,
      async write(pcm) {
        if (closed || !child.stdin.writable) throw new TalkError(410, '喊话连接已断开');
        await new Promise<void>((ok, fail) => child.stdin.write(pcm, err => err ? fail(err) : ok()));
      },
    };
  } catch (error) { await close(); throw error; }
}

type Options = {
  principal(r: FastifyRequest): Promise<string | null>;
  open(channel: string, signal: AbortSignal): Promise<AudioSink>;
};
type Lease = {
  id: string; actor: string; controller: AbortController; sink?: AudioSink;
  until: number; expected: number; nextAudio: number; busy: boolean;
  closing?: Promise<void>;
};
export async function talkbackRoutes(app: FastifyInstance, opts: Options) {
  // One physical loudspeaker session at a time on this embedded appliance.
  let active: Lease | undefined;
  const stop = (s: Lease): Promise<void> => {
    s.controller.abort();
    if (s.closing) return s.closing;
    if (!s.sink) {
      if (active === s) active = undefined;
      return Promise.resolve(); // A late opener closes only its own sink.
    }
    const sink = s.sink;
    s.closing = Promise.resolve().then(() => sink.close()).finally(() => {
      if (active === s) active = undefined;
    });
    return s.closing;
  };
  const timer = setInterval(() => { if (active && active.until <= Date.now()) void stop(active).catch(() => {}); }, 500);
  timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); if (active) await stop(active); });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 3200 }, (_r, b, done) => done(null, b));
  const actors = new WeakMap<FastifyRequest, string>();
  app.addHook('preHandler', async (req, reply) => {
    const actor = await opts.principal(req);
    if (!actor) return reply.code(401).send({ error: '请先登录' });
    actors.set(req, actor);
  });
  app.setErrorHandler((err, _req, reply) => {
    const status = err instanceof TalkError ? err.status : (err as {statusCode?: number}).statusCode || 503;
    return reply.code(status).send({ error: err instanceof TalkError || err instanceof GBError ? err.message : status === 422 ? '设备未完成音频广播协商' : '喊话连接不可用' });
  });
  app.post<{Params:{channel:string}}>('/talkback/channels/:channel', async (req, reply) => {
    if (!/^[\da-f-]{36}$/i.test(req.params.channel)) throw new TalkError(400, '无效通道');
    if (active) throw new TalkError(409, '已有喊话正在进行');
    const lease: Lease = { id: randomUUID(), actor: actors.get(req)!, controller: new AbortController(), until: Date.now()+15000, expected:0, nextAudio:0, busy:false };
    active = lease;
    const abandon = () => { if (!reply.raw.writableEnded) void stop(lease).catch(() => {}); };
    reply.raw.once('close', abandon);
    try {
      lease.sink = await opts.open(req.params.channel, lease.controller.signal);
      if (active !== lease || lease.controller.signal.aborted || lease.until <= Date.now())
        throw new TalkError(410, '喊话启动已取消');
      lease.until = Date.now()+5000;
      return { session: lease.id };
    } catch (e) {
      try { await stop(lease); } finally { if (active === lease) active = undefined; }
      throw e;
    }
  });
  function find(id: string, req: FastifyRequest) {
    if (!active || active.id !== id || active.actor !== actors.get(req))
      throw new TalkError(410, '喊话已结束');
    if (active.controller.signal.aborted || active.until <= Date.now()) {
      void stop(active).catch(() => {});
      throw new TalkError(410, '喊话已结束');
    }
    return active;
  }
  app.post<{Params:{id:string;seq:string}}>('/talkback/:id/audio/:seq', async (req, reply) => {
    const s = find(req.params.id, req);
    if (!Buffer.isBuffer(req.body) || req.body.length !== 3200) throw new TalkError(400, '音频块格式无效');
    if (s.busy || String(s.expected) !== req.params.seq || !s.sink) throw new TalkError(409, '音频顺序已改变');
    const now = Date.now();
    if (s.nextAudio > now+250) throw new TalkError(429, '音频发送过快');
    s.busy=true;
    try {
      if (s.sink.current && !await s.sink.current()) throw new TalkError(410, '源通道已改变');
      if (s.controller.signal.aborted || s.until <= Date.now()) throw new TalkError(410, '喊话已结束');
      await s.sink.write(req.body);
      if (s.controller.signal.aborted || active !== s || s.until <= Date.now())
        throw new TalkError(410, '喊话已结束');
      s.expected++; s.nextAudio=Math.max(now,s.nextAudio)+200; s.until=Date.now()+4000;
    } catch { await stop(s); throw new TalkError(410, '喊话传输已中断'); }
    finally { s.busy=false; }
    return reply.code(204).send();
  });
  app.delete<{Params:{id:string}}>('/talkback/:id', async (req, reply) => {
    await stop(find(req.params.id, req)); return reply.code(204).send();
  });
}
