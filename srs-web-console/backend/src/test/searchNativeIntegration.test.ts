import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { searchRoutes } from '../routes/searchRoutes.js';
import { SearchNativeClient } from '../services/searchNativeClient.js';
import { PersistentSearchWorker } from '../services/persistentSearchWorker.js';
import type { SearchPage, SearchQuery } from '../services/searchContract.js';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const executable = resolve(repository, process.env.AINVR_SEARCH_TEST_FIXTURE_BIN ?? 'test/build/search-foundation/ainvr_search_fixture_server');
const pidFile = resolve(repository, 'test/results/search-native-bff/fixture-pid.json');
const fixtureToken = 'ainvr-search-isolated-fixture-token-20261028';
const infoSchema = z.object({ port: z.number().int().min(1).max(65535), from_ms: z.number().int(), to_ms: z.number().int(),
  channel_id: z.string().uuid(), source_input_id: z.string().uuid(), recording_channel_id: z.string().uuid(),
  model_version: z.literal('fixture-pair-v1'), sample_count: z.literal(26),
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
    const native = new SearchNativeClient(async () => ({ baseUrl: `http://127.0.0.1:${info.port}`, apiToken: fixtureToken, timeoutMs: 3000 }));
    const worker = new PersistentSearchWorker({ native, channels });
    await app.register(searchRoutes, { worker, channels, principal: async request => {
      const actor = request.headers['x-fixture-principal']; return typeof actor === 'string' ? actor : null;
    } });
    await app.ready();
  }, 15000);
  afterEach(() => { allowed = true; });
  afterAll(async () => { try { await app.close(); } finally { await stopFixture(); } }, 12000);
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
      output_channel_id: info.channel_id, recording: { channel_id: info.recording_channel_id, state: 'pending' }, verification: { state: 'unavailable' } });
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
});
