import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { ChannelStoreData } from '../services/channelService.js';
import type { JsonStore } from '../store/jsonStore.js';
import type { AppSettings,Channel } from '../types/channel.js';
import type { PgConfigStore } from '../store/pgStore.js';
import { WhipSessions } from '../services/whipSessions.js';

export function sameToken(expected: string, actual: unknown): boolean {
  if (!expected || typeof actual !== 'string' || actual.length > 512) return false;
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(expected).digest(),
    crypto.createHash('sha256').update(actual).digest());
}

interface Options {
  channels: JsonStore<ChannelStoreData>;
  settings: JsonStore<AppSettings>;
  secrets: () => PgConfigStore | null;
  token: string;
  workerUrl: string;
  srsUrl: string;
  srtEnabled: boolean;
  sessions?: WhipSessions;
  gbStatus?: () => Record<string, unknown>;
  onvifAllowed?: (channel:Channel)=>boolean;
  onvifSource?: (channel:Channel)=>Promise<{source:string;refreshAfterProbe:boolean;allowedCIDRs:string[]}>;
  onvifStatus?: ()=>Record<string,unknown>;
}

// A session is bound to a channel, configuration generation and credential hash.
// The relay cannot turn a supplied Location into an arbitrary HTTP request.
export async function ingestRoutes(app: FastifyInstance, opts: Options) {
  const sessions = opts.sessions ?? new WhipSessions(opts.secrets, opts.srsUrl);
  const worker = async () => {
    const response = await fetch(`${opts.workerUrl}/status`, {
      headers: { 'X-Service-Token': opts.token }, signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error('input service unavailable');
    return await response.json() as any;
  };
  const channel = async (id: string) => (await opts.channels.read()).channels.find(c => c.id === id);
  const credentialKey = (id: string) => `backend/ingest-publish/${id}`;
  const authorize = async (id: string, authorization: unknown) => {
    const c = await channel(id);
    if (!c || c.upstreamProtocol !== 'webrtc' || c.inputEnabled === false) return null;
    const token = await opts.secrets()?.getSecret(credentialKey(id));
    if (!token || !sameToken(`Bearer ${token}`, authorization)) return null;
    return { c, token };
  };
  app.post('/internal/ingest/source', async (req,reply)=>{
    if(!sameToken(opts.token,req.headers['x-service-token']))return reply.code(403).send();
    const parsed=z.object({id:z.string().uuid(),generation:z.string().uuid()}).strict().safeParse(req.body);
    if(!parsed.success)return reply.code(400).send({error:'invalid_source_request'});
    const current=await channel(parsed.data.id);
    if(!current?.onvif||current.inputEnabled===false||current.inputGeneration!==parsed.data.generation||!opts.onvifAllowed?.(current)||!opts.onvifSource)return reply.code(409).send({error:'source_configuration_changed'});
    try{const source=await opts.onvifSource(current);reply.header('Cache-Control','no-store');return {...source,generation:current.inputGeneration}}
    catch(e){const code=(e as any).code;return reply.code(422).send({error:typeof code==='string'&&/^[a-z_]{1,80}$/.test(code)?code:'control_service_unavailable'})}
  });
  app.get('/internal/ingest/config', async (req, reply) => {
    if (!sameToken(opts.token, req.headers['x-service-token'])) return reply.code(403).send();
    const settings = (await opts.settings.read()).ingest ?? { maxPullChannels: 4, connectTimeoutSec: 10 };
    const config = [];
    for (const c of (await opts.channels.read()).channels) {
      if (c.upstreamProtocol !== 'rtsp') continue;
      const prefix = `backend/ingest/${c.id}/`;
      const source = c.sourceRef?.startsWith(prefix) ? await opts.secrets()?.getSecret(c.sourceRef) : null;
      if (!source) continue;
      config.push({ id: c.id, generation: c.inputGeneration, enabled: c.inputEnabled !== false && (!c.onvif||opts.onvifAllowed?.(c)===true),
        source, onvif:!!c.onvif, app: c.app || 'live', stream: c.streamName, transport: c.rtspTransport || 'tcp', timeout: settings.connectTimeoutSec, audioMode:c.inputAudioMode??'off' });
    }
    reply.header('Cache-Control', 'no-store');
    return { channels: config, settings };
  });
  app.get('/api/ingest/capabilities', async () => {
    let status: any = null;
    try { status = await worker(); } catch {}
    const gb = opts.gbStatus?.();
    return { code: 0, data: {
      rtmp: { enabled: true, codecs: ['H.264', 'H.265'], mode: 'push', security: '可信局域网接入' },
      onvif: {enabled:opts.onvifStatus?.().state==='running',mode:'onvif-rtsp',codecs:['H.264','H.265'],reason:opts.onvifStatus?.().state==='running'?'':'请在系统配置中启用 ONVIF 接入并配置摄像头网段'},
      gb28181: { enabled: gb?.state === 'running', configured: !!gb?.configured,
        mode: 'gateway', versions: ['2016', '2022'], codecs: ['H.264', 'H.265'],
        audio: ['AAC', 'G.711 A-law', 'G.711 mu-law'], validation: 'development_unverified',
        reason: gb?.state === 'running' ? '' : '请在系统配置中启用国标网关并检查状态' },
      srt: { enabled: opts.srtEnabled, codecs: ['H.264', 'H.265'], mode: 'push', port: 10080,
        reason: opts.srtEnabled ? '' : '接入端口尚未启用', security: '可信局域网接入，服务级加密由部署配置管理' },
      webrtc: { enabled: !!opts.secrets(), codecs: ['H.264', 'H.265'], mode: 'whip',
        reason: opts.secrets() ? '' : '发布凭据存储尚未就绪' },
      rtsp: { enabled: !!status?.ready && !!opts.secrets(), codecs: ['H.264', 'H.265'], mode: 'pull',
        reason: status?.ready ? '' : '拉流服务尚未就绪', status },
      notes: ['视频保持原编码；AAC 直通，G.711 按配额转 AAC，其他音频明确提示', '浏览器能否使用 H.265 取决于浏览器和设备',
        'WebRTC 输入需要 WHIP 发送端；不支持粘贴任意网页地址拉流'],
    } };
  });
  app.get('/api/ingest/status', async (_req, reply) => {
    try { return { code: 0, data: await worker() }; }
    catch { return reply.code(503).send({ code: 503, error: '拉流服务暂不可用' }); }
  });
  app.post('/api/channels/:id/publish-credential', async (req, reply) => {
    const parsed = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: '无效通道' });
    const pg = opts.secrets();
    if (!pg) return reply.code(503).send({ error: '凭据存储尚未就绪' });
    return sessions.exclusive(parsed.data.id, async () => {
      const c = await channel(parsed.data.id);
      if (!c || c.upstreamProtocol !== 'webrtc') return reply.code(400).send({ error: '此通道不使用发布凭据' });
      await sessions.terminate(c.id);
      const token = crypto.randomBytes(32).toString('hex');
      await pg.setSecret(credentialKey(c.id), token);
      reply.header('Cache-Control', 'no-store');
      return { code: 0, data: { token, authorization: `Bearer ${token}` } };
    });
  });
  app.delete('/api/channels/:id/publish-credential', async (req, reply) => {
    const parsed = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!parsed.success) return reply.code(400).send();
    if (!opts.secrets()) return reply.code(503).send();
    return sessions.exclusive(parsed.data.id, async () => {
      await sessions.terminate(parsed.data.id);
      await opts.secrets()!.deleteSecret(credentialKey(parsed.data.id));
      return reply.code(204).send();
    });
  });
  app.addContentTypeParser('application/sdp', { parseAs: 'string', bodyLimit: 65536 }, (_req, body, done) => done(null, body));
  app.post('/ingest/whip/:id', async (req, reply) => {
    const id = (req.params as any).id;
    if (!z.string().uuid().safeParse(id).success) return reply.code(400).send();
    return sessions.exclusive(id, async () => {
    const auth = await authorize(id, req.headers.authorization);
    if (!auth) return reply.code(401).send({ error: '发布凭据无效或通道未启用' });
    const body = req.body;
    if (typeof body !== 'string' || !/\ba=rtpmap:\d+ (H264|H265)\/90000\b/i.test(body))
      return reply.code(415).send({ error: '需要提供受支持的视频编码' });
    const endpoint = new URL('/rtc/v1/whip/', opts.srsUrl);
    endpoint.searchParams.set('app', auth.c.app || 'live');
    endpoint.searchParams.set('stream', auth.c.streamName);
    // SRS defaults to H.264 even for an H.265-only SDP offer.
    if (!/\ba=rtpmap:\d+ H264\/90000\b/i.test(body)) endpoint.searchParams.set('codec', 'hevc');
    // Actual destination IP, not Docker's private address, becomes ICE candidate.
    endpoint.searchParams.set('eip', String(req.headers.host || '').replace(/:\d+$/, ''));
    try {
      await sessions.terminate(id);
      const result = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/sdp' },
        body, signal: AbortSignal.timeout(6000), redirect: 'error' });
      const answer = await result.text();
      if (result.status !== 201) return reply.code(502).send({ error: '视频发布协商失败，请检查编码和连接参数' });
      const location = new URL(result.headers.get('location') || '', opts.srsUrl);
      if (location.pathname !== '/rtc/v1/whip/') return reply.code(502).send({ error: '发布会话地址无效' });
      const key = crypto.randomUUID();
      const record = { key, generation: auth.c.inputGeneration, path: location.pathname + location.search,
        credential: crypto.createHash('sha256').update(auth.token).digest('hex') };
      try { await sessions.set(id, record); }
      catch {
        await fetch(`${opts.srsUrl}${record.path}`, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(3000) });
        throw new Error('session persistence failed');
      }
      return reply.code(201).header('Content-Type', 'application/sdp')
        .header('Location', `/ingest/whip/${id}/sessions/${key}`).send(answer);
    } catch { return reply.code(502).send({ error: '视频接入暂不可用，请重试' }); }
    });
  });
  app.delete('/ingest/whip/:id/sessions/:session', async (req, reply) => {
    const { id, session } = req.params as any;
    if (!z.string().uuid().safeParse(id).success || !z.string().uuid().safeParse(session).success) return reply.code(404).send();
    return sessions.exclusive(id, async () => {
    const auth = await authorize(id, req.headers.authorization);
    const s = auth ? await sessions.get(id) : null;
    if (!auth || !s || s.key !== session || !sameToken(s.credential, crypto.createHash('sha256').update(auth.token).digest('hex')))
      return reply.code(404).send();
    try {
      await sessions.terminate(id);
      return reply.code(204).send();
    } catch { return reply.code(502).send(); }
    });
  });
  // SRS 7 does not implement trickle ICE PATCH. Tell senders to gather an offer.
  app.patch('/ingest/whip/:id/sessions/:session', async (_req, reply) => reply.code(405).header('Allow', 'DELETE').send());
}
