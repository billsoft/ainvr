import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { searchRoutes } from '../routes/searchRoutes.js';
import { SearchNativeClient } from '../services/searchNativeClient.js';
import { PersistentSearchWorker } from '../services/persistentSearchWorker.js';
import type { SearchPage, SearchQuery } from '../services/searchContract.js';
import { SearchJobs } from '../store/searchJobs.js';
import { SearchVerifyRunner } from '../services/searchVerifyRunner.js';
import { SearchVerifyLlmClient } from '../services/searchVerifyLlm.js';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const executable = resolve(repository, process.env.AINVR_SEARCH_TEST_FIXTURE_BIN ?? 'test/build/search-foundation/ainvr_search_fixture_server');
const pidFile = resolve(repository, 'test/results/search-native-bff/fixture-pid.json');
const fixtureToken = 'ainvr-search-isolated-fixture-token-20261028';
const infoSchema = z.object({ port: z.number().int().min(1).max(65535), from_ms: z.number().int(), to_ms: z.number().int(),
  channel_id: z.string().uuid(), source_input_id: z.string().uuid(), recording_channel_id: z.string().uuid(),
  model_version: z.literal('fixture-pair-v1'), sample_count: z.literal(28),
  input_path: z.literal('/live/fixture_input'), output_path: z.literal('/live/fixture_output') }).strict();
type FixtureInfo = z.infer<typeof infoSchema>;
async function fragmentedPost(port: number, content: Buffer, split: number, boundary: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveResponse, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }); socket.setNoDelay(true);
    const chunks: Buffer[] = []; let size = 0, settled = false;
    let continuation: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(continuation); socket.destroy();
      if (error) { reject(error); return; }
      const bytes = Buffer.concat(chunks); const headerEnd = bytes.indexOf('\r\n\r\n');
      const match = /^HTTP\/1\.[01] (\d{3}) /u.exec(bytes.toString('latin1', 0, Math.max(0, headerEnd)));
      if (!match || headerEnd < 0) { reject(new Error('Malformed fixture HTTP response')); return; }
      resolveResponse({ status: Number(match[1]), body: bytes.subarray(headerEnd + 4).toString('utf8') });
    };
    socket.setTimeout(4000, () => finish(new Error('Fragmented fixture request timed out')));
    socket.on('error', error => finish(error)); socket.on('end', () => finish());
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk); size += chunk.length; if (size > 1024 * 1024) finish(new Error('Fixture response too large')); });
    socket.on('connect', () => {
      const header = Buffer.from(`POST /v1/samples HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nx-service-token: ${'p'.repeat(48)}\r\nx-search-config-revision: ${'0'.repeat(64)}\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\nContent-Length: ${content.length}\r\nConnection: close\r\n\r\n`);
      if (split >= content.length) { socket.end(Buffer.concat([header, content])); return; }
      socket.write(Buffer.concat([header, content.subarray(0, split)]));
      continuation = setTimeout(() => socket.end(content.subarray(split)), 30);
    });
  });
}

// Real BFF -> native HTTP -> a throwaway Mongo database. Only login/catalog are
// test callbacks. Text embeddings and the fixed JPEG are explicitly synthetic;
// this suite makes no model-accuracy or image-preprocessing quality claim.
describe.skipIf(process.env.AINVR_SEARCH_TEST_MONGO !== '1')('native search business integration', () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  let info: FixtureInfo;
  let stderr = '';
  let allowed = true;
  let native: SearchNativeClient;
  let verifier: SearchVerifyRunner | undefined;
  let verifyJobs: SearchJobs;
  let pg: Pool | undefined, pgAdmin: Pool | undefined, pgSchema = '';
  const fakeLlm = Fastify({ bodyLimit: 12 * 1024 * 1024 });
  const received: { request_id: string; query: string }[] = [], cancellations: string[] = [];
  let fakeMode: 'normal' | 'hold' | 'timeout' = 'normal', failCancel = false;
  const held = new Map<string, () => void>();
  let makeVerifier: () => SearchVerifyRunner;
  const app = Fastify();
  const headers = { 'x-fixture-principal': 'operator' };
  function exited(process: ChildProcessWithoutNullStreams) { return process.exitCode !== null || process.signalCode !== null; }
  async function waitExit(process: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (exited(process)) return true;
    return new Promise(resolveResult => {
      const onExit = () => { clearTimeout(timer); resolveResult(true); };
      const timer = setTimeout(() => { process.removeListener('exit', onExit); resolveResult(false); }, timeoutMs);
      process.once('exit', onExit);
    });
  }
  async function stopFixture() {
    if (!child) return;
    const process = child;
    if (!exited(process)) process.kill('SIGTERM');
    const graceful = await waitExit(process, 8000);
    if (!graceful) { process.kill('SIGKILL'); await waitExit(process, 2000); }
    try {
      const record = JSON.parse(await readFile(pidFile, 'utf8')) as { pid?: number };
      if (record.pid === process.pid) await unlink(pidFile);
    } catch { /* the bounded shell harness is a second owner-checked cleanup */ }
    child = undefined;
    if (!graceful || process.exitCode !== 0) throw new Error(`Native fixture did not stop cleanly (${process.exitCode ?? process.signalCode}); ${stderr}`);
  }
  beforeAll(async () => {
    await mkdir(resolve(repository, 'test/results/search-native-bff'), { recursive: true });
    child = spawn(executable, [], { cwd: repository, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8', AINVR_SEARCH_TEST_MONGO: '1' } });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4096); });
    if (child.pid) {
      const stat = await readFile(`/proc/${child.pid}/stat`, 'utf8');
      const startTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
      await writeFile(pidFile, JSON.stringify({ pid: child.pid, executable, start_time: startTime, run_id: process.env.AINVR_SEARCH_TEST_RUN_ID ?? 'direct' }), { mode: 0o600 });
    }
    const processHandle = child;
    info = await new Promise<FixtureInfo>((resolveInfo, reject) => {
      let stdout = '';
      const timer = setTimeout(() => reject(new Error(`Native fixture startup timed out; ${stderr}`)), 10000);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      processHandle.once('error', fail);
      processHandle.once('exit', code => fail(new Error(`Native fixture exited before ready (${code}); ${stderr}`)));
      processHandle.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > 16384) { fail(new Error('Unexpected fixture output limit')); return; }
        const newline = stdout.indexOf('\n'); if (newline < 0) return;
        try { const value = infoSchema.parse(JSON.parse(stdout.slice(0, newline))); clearTimeout(timer); resolveInfo(value); }
        catch { fail(new Error(`Invalid native fixture ready message; ${stderr}`)); }
      });
    });
    const catalog = [{ id: info.channel_id, name: '联调摄像头AI输出' },
      { id: info.source_input_id, name: '联调原始输入' }, { id: info.recording_channel_id, name: '联调录像通道' }];
    const channels = async () => allowed ? catalog : [];
    native = new SearchNativeClient(async () => ({ baseUrl: `http://127.0.0.1:${info.port}`, apiToken: fixtureToken, timeoutMs: 3000 }));
    if (process.env.AINVR_SEARCH_TEST_PG === '1') {
      pgSchema = 'search_verify_' + randomUUID().replaceAll('-', '');
      const connection = { host: '127.0.0.1', port: 25439, user: 'alarm_test', database: 'alarm_test' };
      pgAdmin = new Pool(connection); await pgAdmin.query(`CREATE SCHEMA ${pgSchema}`);
      pg = new Pool({ ...connection, options: `-c search_path=${pgSchema}`, statement_timeout: 10000, query_timeout: 15000 });
      for (const name of ['017_search.sql', '019_search_shard_publication.sql', '021_search_refresh_gc.sql'])
        await pg.query(readFileSync(new URL('../store/migrations/' + name, import.meta.url), 'utf8'));
      verifyJobs = new SearchJobs(pg);
      const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
      const taskProfile = { template: 'search-verify-zh-v1', template_sha256: 'e'.repeat(64), preprocessing_version: 'fixture-letterbox-v1',
        decision_policy: 'abc-visible-v1', model: { package_id: 'qwen3vl-4b-review-v3', package_sha256: 'f'.repeat(64) },
        enabled: true, available: true, reason: null, validated: false };
      const fakeKey = 'isolated-search-verify-key-20261028-only';
      fakeLlm.addHook('onRequest', async (request, reply) => { if (request.headers.authorization !== `Bearer ${fakeKey}`) return reply.code(403).send({ error: { code: 'forbidden' } }); });
      fakeLlm.get('/v1/ainvr/tasks/search-verify-zh-v1/profile', async () => taskProfile);
      fakeLlm.post('/v1/ainvr/tasks/search-verify-zh-v1/cancel', async (request, reply) => {
        const id = z.object({ request_id: z.string() }).strict().parse(request.body).request_id;
        cancellations.push(id); if (failCancel) return reply.code(503).send({ error: { code: 'fixture_cancel_unavailable' } });
        const release = held.get(id); release?.(); held.delete(id); return { request_id: id, cancelled: !!release };
      });
      fakeLlm.post('/v1/ainvr/tasks/search-verify-zh-v1', async (request, reply) => {
        const body = z.object({ request_id: z.string(), query: z.string(), question_scope: z.literal('visible'),
          evidence: z.object({ kind: z.enum(['object', 'scene']), frame_id: z.string().uuid(), sha256: z.string() }).strict(),
          image: z.object({ jpeg_base64: z.string(), fit: z.literal('letterbox') }).strict() }).strict().parse(request.body);
        expect(hash(Buffer.from(body.image.jpeg_base64, 'base64'))).toBe(body.evidence.sha256);
        received.push({ request_id: body.request_id, query: body.query });
        if (fakeMode === 'timeout') return reply.code(504).send({ error: { code: 'fixture_timeout' } });
        if (fakeMode === 'hold') { await new Promise<void>(resolveHeld => { held.set(body.request_id, resolveHeld); }); return reply.code(410).send({ error: { code: 'cancelled' } }); }
        const inputSha = hash(JSON.stringify({ evidence_sha256: body.evidence.sha256, frame_id: body.evidence.frame_id, kind: body.evidence.kind,
          model_sha256: taskProfile.model.package_sha256, preprocessing_version: taskProfile.preprocessing_version,
          query: body.query, question_scope: body.question_scope, template_sha256: taskProfile.template_sha256 }));
        return { schema: 'ainvr.search_verification.v1', request_id: body.request_id, frame_id: body.evidence.frame_id, evidence_sha256: body.evidence.sha256,
          query_sha256: hash(body.query), input_sha256: inputSha, question_scope: body.question_scope, kind: body.evidence.kind,
          template: taskProfile.template, template_sha256: taskProfile.template_sha256, preprocessing_version: taskProfile.preprocessing_version,
          decision_policy: taskProfile.decision_policy, model: taskProfile.model, validated: false, score_kind: 'three_way_softmax_uncalibrated',
          decision: 'match', reason: 'visible_evidence', logits: { A: 4, B: 1, C: 0 }, reference_scores: { A: .9, B: .05, C: .05 }, timing_ms: { queue: 0, preprocess: 0, total: 1 } };
      });
      const fakeAddress = new URL(await fakeLlm.listen({ host: '127.0.0.1', port: 0 }));
      // Production connector still validates its fixed loopback:8300 origin.
      // Only this fixture maps its fetch to an ephemeral fake HTTP endpoint.
      const llm = new SearchVerifyLlmClient(async () => ({ baseUrl: 'http://127.0.0.1:8300', inference: fakeKey, inferenceTimeoutMs: 10000 }), async (input, options) => {
        const url = new URL(String(input)); expect(url.origin).toBe('http://127.0.0.1:8300'); url.port = fakeAddress.port; return fetch(url, options);
      });
      makeVerifier = () => new SearchVerifyRunner({ jobs: verifyJobs, native, llm,
        channels: async actor => actor === 'verify-operator' && allowed ? catalog : [], heartbeatMs: 100, intervalMs: 100 });
      verifier = makeVerifier();
    }
    const worker = new PersistentSearchWorker({ native, channels, verificationPublished: () => verifier?.wake(),
      verificationCancel: (id, actor) => verifier?.cancel(id, actor) ?? Promise.resolve() });
    await app.register(searchRoutes, { worker, channels, principal: async request => {
      const actor = request.headers['x-fixture-principal']; return typeof actor === 'string' ? actor : null;
    } });
    await app.ready();
  }, 15000);
  afterEach(() => { allowed = true; });
  afterAll(async () => {
    try { await verifier?.stop(); for (const release of held.values()) release(); await app.close(); await fakeLlm.close(); }
    finally { try { await pg?.end(); if (pgAdmin) { await pgAdmin.query(`DROP SCHEMA ${pgSchema} CASCADE`); await pgAdmin.end(); } }
      finally { await stopFixture(); } }
  }, 15000);
  function input(requestId = randomUUID()): SearchQuery {
    return { query: '穿红色上衣的人', request_id: requestId, verify: true,
      scope: { channel_ids: [info.channel_id], from: new Date(info.from_ms).toISOString(), to: new Date(info.to_ms).toISOString() } };
  }
  async function query(request = input()) {
    const response = await app.inject({ method: 'POST', url: '/search/text', headers, payload: request });
    expect(response.statusCode, response.body).toBe(200);
    return { request, page: response.json<SearchPage>() };
  }
  it('authenticates and reaches actual native status and Mongo-backed ranked results', async () => {
    expect((await app.inject({ method: 'GET', url: '/search/status' })).statusCode).toBe(401);
    const status = await app.inject({ method: 'GET', url: '/search/status', headers });
    expect(status.json()).toEqual({ ready: true, reason: null, model_version: info.model_version });
    const { page } = await query();
    expect(page.items).toHaveLength(20); expect(page.next_cursor).toBe('v1.20'); expect(page.coverage).toBe('sampled');
    expect(page.items[0]).toMatchObject({ channel_id: info.channel_id, source_input_id: info.source_input_id,
      output_channel_id: info.channel_id, recording: { channel_id: info.recording_channel_id, state: 'pending' }, verification: { state: 'candidate' } });
  });
  it('keeps both pages stable when a newly inserted high-ranked sample enters the live index', async () => {
    const { request, page } = await query();
    const second = await app.inject({ method: 'GET', url: `/search/${page.search_id}?cursor=${page.next_cursor}`, headers });
    expect(second.statusCode, second.body).toBe(200); const tail = second.json<SearchPage>();
    expect(tail.items).toHaveLength(6); expect(tail.next_cursor).toBeNull();
    const first = page.items[0], image = await app.inject({ method: 'GET', headers,
      url: `/search/${page.search_id}/results/${first.id}/images/${first.frames[0].id}` });
    expect(image.statusCode).toBe(200);
    const newId = '00000000-0000-4000-8000-100000000090';
    const metadata = { id: newId, channel_id: info.channel_id, processor_id: 'fixture_processor', stream_session_id: 'fixture_session', track_id: 'new_track',
      model_version: info.model_version, captured_ms: info.from_ms + 20000, kind: 'object', expires_ms: Date.now() + 3600000, vector: [1, 0],
      evidence: { schema_version: '1.0', role: 'match', source_input_id: info.source_input_id, output_channel_id: info.channel_id,
        input_path: info.input_path, output_path: info.output_path,
        recording_channel_id: info.recording_channel_id, stream_session_id: 'fixture_session', source_pts_ns: '20000000000', source_frame_index: '999',
        frame_id: '00000000-0000-4000-8000-100000000999', frame_width: 1920, frame_height: 1080 } };
    // Several bounded producer requests exercise actual multipart framing and
    // connection reuse rather than relying on a single lucky transport request.
    for (let n = 0; n < 8; n++) {
      const value = { ...metadata, id: `00000000-0000-4000-8000-${100000000090 + n}`, track_id: `new_track_${n}`, captured_ms: metadata.captured_ms + n * 100,
        evidence: { ...metadata.evidence, frame_id: `00000000-0000-4000-8000-${100000000999 + n}`,
          source_frame_index: `${999 + n}`, source_pts_ns: `${20000000000 + n * 100000000}` } };
      const body = new FormData(); body.set('metadata', new Blob([JSON.stringify(value)], { type: 'application/json' }), 'metadata.json');
      body.set('image', new Blob([new Uint8Array(image.rawPayload)], { type: 'image/jpeg' }), 'frame.jpg');
      const inserted = await fetch(`http://127.0.0.1:${info.port}/v1/samples`, { method: 'POST', redirect: 'error',
        headers: { 'x-service-token': 'p'.repeat(48), 'x-search-config-revision': '0'.repeat(64) }, body, signal: AbortSignal.timeout(3000) });
      const insertionReply = await inserted.text();
      const diagnostic = { iteration: n, reply: insertionReply, image_bytes: image.rawPayload.length,
        image_head: [...image.rawPayload.subarray(0, 4)], image_tail: [...image.rawPayload.subarray(-4)],
        metadata_types: Object.fromEntries(Object.entries(value).map(([key, field]) => [key, Array.isArray(field) ? 'array' : typeof field])) };
      expect(inserted.status, JSON.stringify(diagnostic)).toBe(200);
    }
    const repeat = await query(request); expect(repeat.page.items.map(i => i.id)).toEqual(page.items.map(i => i.id));
    const repeatSecond = await app.inject({ method: 'GET', url: `/search/${page.search_id}?cursor=${page.next_cursor}`, headers });
    expect(repeatSecond.json<SearchPage>().items.map(i => i.id)).toEqual(tail.items.map(i => i.id));
    const fresh = await query(); expect(fresh.page.items[0].id).toBe(newId);
  });
  it('freezes three existing group frames with actual BFF image authorization and recording bounds', async () => {
    const {page}=await query(), item=page.items.find(candidate=>candidate.id==='00000000-0000-4000-8000-100000000100')!;
    expect(item).toBeDefined();
    expect(item.frames.map(frame=>frame.role)).toEqual(['match','before','after']);
    expect(Date.parse(item.started_at)).toBe(info.from_ms+50);expect(Date.parse(item.ended_at)).toBe(info.from_ms+500);
    expect(item.recording.channel_id).toBe(info.recording_channel_id);
    const before=item.frames.find(frame=>frame.role==='before')!, after=item.frames.find(frame=>frame.role==='after')!;
    for(const frame of [before,after]){
      const image=await app.inject({method:'GET',headers,url:`/search/${page.search_id}/results/${item.id}/images/${frame.id}`});
      expect(image.statusCode,image.body).toBe(200);expect(image.headers['content-type']).toBe('image/jpeg');
      expect([...image.rawPayload.subarray(0,2)]).toEqual([255,216]);
    }
    const cross=await app.inject({method:'GET',headers,url:`/search/${page.search_id}/results/${page.items.find(candidate=>candidate.id!==item.id)!.id}/images/${before.id}`});
    expect(cross.statusCode).toBe(404);
    const other=await app.inject({method:'GET',headers:{'x-fixture-principal':'another-operator'},url:`/search/${page.search_id}/results/${item.id}/images/${before.id}`});
    expect(other.statusCode).toBe(404);
  });
  it('ties images to an owned result and its exact frame', async () => {
    const { page } = await query(), item = page.items[0], second = page.items[1];
    const url = `/search/${page.search_id}/results/${item.id}/images/${item.frames[0].id}`;
    const image = await app.inject({ method: 'GET', url, headers });
    expect(image.statusCode, image.body).toBe(200); expect(image.headers['content-type']).toBe('image/jpeg');
    expect([...image.rawPayload.subarray(0, 2)]).toEqual([255, 216]);
    const wrongFrame = `/search/${page.search_id}/results/${second.id}/images/${item.frames[0].id}`;
    expect((await app.inject({ method: 'GET', url: wrongFrame, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url, headers: { 'x-fixture-principal': 'another-operator' } })).statusCode).toBe(404);
  });
  it('accepts complete producer evidence when TCP splits a multipart boundary prefix', async () => {
    const { page } = await query(), item = page.items[0];
    const image = await app.inject({ method: 'GET', headers,
      url: `/search/${page.search_id}/results/${item.id}/images/${item.frames[0].id}` });
    expect(image.statusCode).toBe(200);
    const metadataResponse = await fetch(`http://127.0.0.1:${info.port}/v1/samples/${item.id}?channel_id=${info.channel_id}&model_version=${info.model_version}`,
      { headers: { 'x-service-token': fixtureToken }, signal: AbortSignal.timeout(3000), redirect: 'error' });
    expect(metadataResponse.status).toBe(200); const original = await metadataResponse.json() as Record<string, unknown>;
    // Server-managed generation is returned to readers, never producer input.
    const producerMetadata = { ...original }; delete producerMetadata.fingerprint;
    const cases = [{ part: 'metadata', prefix: 1 }, { part: 'metadata', prefix: 3 }, { part: 'image', prefix: 1 }] as const;
    for (const [index, test] of cases.entries()) {
      const value = { ...producerMetadata, id: `00000000-0000-4000-8000-${100000000800 + index}`, processor_id: 'fixture_processor',
        stream_session_id: 'fixture_session', track_id: `fragmented_${index}`, kind: 'object', vector: [1, 0],
        captured_ms: info.from_ms + 23000 + index * 100, expires_ms: Date.now() + 3600000,
        evidence: { ...(original.evidence as Record<string, unknown>), frame_id: `00000000-0000-4000-8000-${100000002000 + index}`,
          source_frame_index: `${2000 + index}`, source_pts_ns: `${23000000000 + index * 100000000}` } };
      const boundary = `ainvr-fragmented-boundary-${index}`;
      const start = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"; filename="metadata.json"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(value)}`);
      const middle = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="frame.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`);
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const content = Buffer.concat([start, middle, image.rawPayload, tail]);
      const split = (test.part === 'metadata' ? start.length : start.length + middle.length + image.rawPayload.length) + test.prefix;
      const control = await fragmentedPost(info.port, content, content.length, boundary);
      expect(control.status, JSON.stringify({ control, test, phase: 'same body without splitting' })).toBe(200);
      const response = await fragmentedPost(info.port, content, split, boundary);
      expect(response.status, JSON.stringify({ test, response })).toBe(200);
    }
  }, 15000);
  it('persists feedback separately without rerunning or reordering the shortlist', async () => {
    const { request, page } = await query(), item = page.items[0];
    const feedback = await app.inject({ method: 'POST', url: `/search/${page.search_id}/results/${item.id}/feedback`, headers, payload: { relevant: false } });
    expect(feedback.statusCode, feedback.body).toBe(200);
    const detail = await app.inject({ method: 'GET', url: `/search/${page.search_id}/results/${item.id}`, headers });
    expect(detail.json().feedback).toBe('irrelevant');
    const repeat = await query(request); expect(repeat.page.items.map(i => i.id)).toEqual(page.items.map(i => i.id));
    expect(repeat.page.items[0].feedback).toBe('irrelevant');
  });
  it('rejects missing or mismatched actual processor paths before storing, and accepts an exact same-frame retry', async () => {
    const { page } = await query(), item = page.items[0];
    const metadataResponse = await fetch(`http://127.0.0.1:${info.port}/v1/samples/${item.id}?channel_id=${info.channel_id}&model_version=${info.model_version}`,
      { headers: { 'x-service-token': fixtureToken }, signal: AbortSignal.timeout(3000), redirect: 'error' });
    expect(metadataResponse.status).toBe(200);
    const metadata = await metadataResponse.json() as Record<string, unknown>; delete metadata.fingerprint;
    metadata.vector = [1, 0];
    const image = await app.inject({ method: 'GET', headers, url: `/search/${page.search_id}/results/${item.id}/images/${item.frames[0].id}` });
    expect(image.statusCode).toBe(200);
    const post = async (sample: Record<string, unknown>) => {
      const body = new FormData(); body.set('metadata', new Blob([JSON.stringify(sample)], { type: 'application/json' }), 'metadata.json');
      body.set('image', new Blob([new Uint8Array(image.rawPayload)], { type: 'image/jpeg' }), 'frame.jpg');
      return fetch(`http://127.0.0.1:${info.port}/v1/samples`, { method: 'POST', redirect: 'error', body,
        headers: { 'x-service-token': 'p'.repeat(48), 'x-search-config-revision': '0'.repeat(64) }, signal: AbortSignal.timeout(3000) });
    };
    for (const field of ['input_path', 'output_path']) {
      const wrong = structuredClone(metadata); (wrong.evidence as Record<string, unknown>)[field] = '/live/wrong-source';
      const mismatch = await post(wrong); expect(mismatch.status).toBe(403); expect(await mismatch.json()).toEqual({ error: 'source_not_authorized' });
      delete (wrong.evidence as Record<string, unknown>)[field];
      const missing = await post(wrong); expect(missing.status).toBe(403); expect(await missing.json()).toEqual({ error: 'source_not_authorized' });
    }
    const exact = await post(metadata); expect(exact.status).toBe(200); expect(await exact.json()).toMatchObject({ stored: true, id: item.id });
  });
  it('cancels published or not-yet-submitted requests without allowing late publication', async () => {
    const { request, page } = await query();
    expect((await app.inject({ method: 'POST', url: `/search/${page.search_id}/cancel`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/search/${page.search_id}`, headers })).statusCode).toBe(404);
    const late = await app.inject({ method: 'POST', url: '/search/text', headers, payload: request });
    expect(late.statusCode, late.body).toBe(410);
    const notSubmitted = input();
    expect((await app.inject({ method: 'POST', url: `/search/${notSubmitted.request_id}/cancel`, headers })).statusCode).toBe(200);
    const cancelled = await app.inject({ method: 'POST', url: '/search/text', headers, payload: notSubmitted });
    expect(cancelled.statusCode, cancelled.body).toBe(410);
  });
  it('denies pages, image evidence and feedback after channel permission is revoked', async () => {
    const { page } = await query(), item = page.items[0]; allowed = false;
    for (const url of [`/search/${page.search_id}`, `/search/${page.search_id}/results/${item.id}`,
      `/search/${page.search_id}/results/${item.id}/images/${item.frames[0].id}`]) {
      const response = await app.inject({ method: 'GET', url, headers }); expect(response.statusCode, response.body).toBe(403);
    }
    const feedback = await app.inject({ method: 'POST', url: `/search/${page.search_id}/results/${item.id}/feedback`, headers, payload: { relevant: true } });
    expect(feedback.statusCode, feedback.body).toBe(403);
  });
  const verifyHeaders = { 'x-fixture-principal': 'verify-operator' };
  async function verifyQuery(text: string) {
    const request = { ...input(), query: text };
    const response = await app.inject({ method: 'POST', url: '/search/text', headers: verifyHeaders, payload: request });
    expect(response.statusCode, response.body).toBe(200); return { request, page: response.json<SearchPage>() };
  }
  async function publicVerification(id: string) {
    const response = await app.inject({ method: 'GET', url: `/search/${id}`, headers: verifyHeaders });
    expect(response.statusCode, response.body).toBe(200); return response.json<SearchPage>();
  }
  async function waitVerified(id: string, cached: boolean) {
    let page = await publicVerification(id);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !page.items.slice(0, 5).every(item => item.verification.state === 'match' && !!item.verification.cached === cached)) {
      await new Promise(resolveWait => setTimeout(resolveWait, 40)); page = await publicVerification(id);
    }
    expect(page.items.slice(0, 5).map(item => item.verification), 'bounded real verification progress').toEqual(Array.from({ length: 5 }, () =>
      ({ state: 'match', validated: false, cached, reason: 'visible_evidence' })));
    return page;
  }
  it.skipIf(process.env.AINVR_SEARCH_TEST_PG !== '1')('real PG jobs, native HTTP/Mongo and bounded fake LLM verify only five results and reuse an exact cache', async () => {
    const before = received.length, first = await verifyQuery('组合验证红衣人员');
    const page = await waitVerified(first.page.search_id, false);
    expect(page.items.slice(0, 5).map(item => item.verification)).toEqual(Array.from({ length: 5 }, () => ({ state: 'match', validated: false, cached: false, reason: 'visible_evidence' })));
    expect(page.items.slice(5).every(item => item.verification.state === 'candidate')).toBe(true);
    expect(received.length - before).toBe(5);
    const stored = await pg!.query("SELECT state,payload FROM search_jobs WHERE actor=$1 AND payload->>'search_id'=$2", ['verify-operator', first.page.search_id]);
    expect(stored.rows).toHaveLength(5); expect(stored.rows.every(row => row.state === 'succeeded')).toBe(true);
    expect(JSON.stringify(stored.rows)).not.toContain(first.request.query); expect(JSON.stringify(stored.rows)).not.toContain('jpeg_base64');
    const cached = await verifyQuery(first.request.query);
    const cachedPage = await waitVerified(cached.page.search_id, true);
    expect(cachedPage.items.slice(0, 5).every(item => item.verification.state === 'match' && item.verification.cached && item.verification.validated === false)).toBe(true);
    expect(received.length - before).toBe(5);
    allowed = false;
    const denied = await app.inject({ method: 'GET', url: `/search/${cached.page.search_id}`, headers: verifyHeaders });
    expect(denied.statusCode).toBe(403);
  }, 20000);
  it.skipIf(process.env.AINVR_SEARCH_TEST_PG !== '1')('a restarted real runner recovers an unknown terminal job without another inference of its request', async () => {
    const before = received.length; fakeMode = 'timeout'; failCancel = true;
    const first = await verifyQuery('组合验证背包人员');
    for (let n = 0; n < 100 && received.length === before; n++) { await verifier!.tick(); if (received.length === before) await new Promise(resolveWait => setTimeout(resolveWait, 10)); }
    await verifier!.stop();
    expect(received.length).toBe(before + 1); const unknownId = received.at(-1)!.request_id;
    const pending = await publicVerification(first.page.search_id); expect(pending.items[0]!.verification.state).toBe('running');
    const state = await pg!.query("SELECT state FROM search_jobs WHERE payload->>'search_id'=$1 ORDER BY created_at,id", [first.page.search_id]);
    expect(state.rows.filter(row => row.state === 'failed')).toHaveLength(1);
    verifier = makeVerifier(); fakeMode = 'normal'; failCancel = false;
    for (let n = 0; n < 4; n++) await verifier.tick();
    const recovered = await publicVerification(first.page.search_id);
    expect(recovered.items[0]!.verification).toMatchObject({ state: 'unavailable', validated: false });
    expect(received.filter(row => row.request_id === unknownId)).toHaveLength(1); expect(cancellations).toContain(unknownId);
    expect(recovered.items.slice(1, 5).every(item => item.verification.state === 'match')).toBe(true);
  }, 20000);
  it.skipIf(process.env.AINVR_SEARCH_TEST_PG !== '1')('public cancellation stops a real in-flight request and removes result/image access', async () => {
    fakeMode = 'hold'; const before = received.length;
    const first = await verifyQuery('组合验证蓝衣人员'), running = verifier!.tick();
    for (let n = 0; n < 500 && received.length === before; n++) await new Promise(resolveWait => setTimeout(resolveWait, 10));
    expect(received.length).toBe(before + 1); const requestId = received.at(-1)!.request_id;
    const cancelled = await app.inject({ method: 'POST', url: `/search/${first.page.search_id}/cancel`, headers: verifyHeaders });
    expect(cancelled.statusCode, cancelled.body).toBe(200); await running; fakeMode = 'normal';
    expect(cancellations).toContain(requestId);
    expect((await app.inject({ method: 'GET', url: `/search/${first.page.search_id}`, headers: verifyHeaders })).statusCode).toBe(404);
    const item = first.page.items[0]!;
    expect((await app.inject({ method: 'GET', url: `/search/${first.page.search_id}/results/${item.id}/images/${item.frames[0].id}`, headers: verifyHeaders })).statusCode).toBe(404);
    expect(received.filter(row => row.request_id === requestId)).toHaveLength(1);
  }, 15000);
});
