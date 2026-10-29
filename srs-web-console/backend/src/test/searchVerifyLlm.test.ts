import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { SearchVerifyLlmClient, SearchVerifyLlmError, searchVerifyInputSha, searchVerifyQuerySha } from '../services/searchVerifyLlm.js';
import { searchVerificationProfileFingerprint, type SearchVerificationProfile, type SearchVerificationBinding } from '../services/searchVerificationContract.js';
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const profileBase = { task_id: 'search-verify-zh-v1' as const, template_sha256: '1'.repeat(64), preprocessing_version: 'jpeg420-vpu-gles-rgb-letterbox896x448-v1',
  decision_policy: 'abc-visible-v1' as const, model_package_id: 'qwen3vl-4b-review-v3', model_package_sha256: '2'.repeat(64) };
const profile: SearchVerificationProfile = { ...profileBase, profile_fp: searchVerificationProfileFingerprint(profileBase) };
const jpeg = Buffer.from([255, 216, 0, 255, 217]), query = '穿红衣服的人';
const binding: SearchVerificationBinding = { actor: 'test-actor', search_id: randomUUID(), version: 'a'.repeat(64), sample_id: randomUUID(),
  frame_id: randomUUID(), fingerprint: 'b'.repeat(64), query_sha256: sha(query), jpeg_sha256: sha(jpeg), profile_fp: profile.profile_fp, question_scope: 'visible' };
const profileReply = () => ({ template: profile.task_id, template_sha256: profile.template_sha256, preprocessing_version: profile.preprocessing_version,
  decision_policy: profile.decision_policy, model: { package_id: profile.model_package_id, package_sha256: profile.model_package_sha256 },
  enabled: true, available: true, reason: null, validated: false });
const result = () => ({ schema: 'ainvr.search_verification.v1', request_id: 'verify-one', frame_id: binding.frame_id, evidence_sha256: binding.jpeg_sha256,
  query_sha256: binding.query_sha256, input_sha256: searchVerifyInputSha(query, binding, profile, 'object'), question_scope: 'visible', kind: 'object',
  template: profile.task_id, template_sha256: profile.template_sha256, preprocessing_version: profile.preprocessing_version,
  model: { package_id: profile.model_package_id, package_sha256: profile.model_package_sha256 }, validated: false,
  decision_policy: profile.decision_policy, score_kind: 'three_way_softmax_uncalibrated', decision: 'match', reason: 'visible_evidence',
  logits: { A: 4, B: 1, C: 0 }, reference_scores: { A: .9, B: .05, C: .05 }, timing_ms: { queue: 0, preprocess: 1, total: 2 } });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function fixture(reply: () => Response = () => json(result())) {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => reply());
  const connection = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:8300', inference: 's'.repeat(48), inferenceTimeoutMs: 60000 }));
  return { fetcher, connection, client: new SearchVerifyLlmClient(connection, fetcher as typeof fetch) };
}
it('reads actual profile metadata with the dedicated caller and preserves the uncalibrated contract', async () => {
  const f = fixture(() => json(profileReply())); expect(await f.client.profile()).toEqual(profile);
  const [url, options] = f.fetcher.mock.calls[0]! as unknown as [URL, RequestInit];
  expect(url.pathname).toBe('/v1/ainvr/tasks/search-verify-zh-v1/profile'); expect(options.method).toBe('GET'); expect(options.redirect).toBe('error');
  expect(options.headers).toEqual({ authorization: 'Bearer ' + 's'.repeat(48) });
  const unavailable = fixture(() => json({ ...profileReply(), available: false, model: null, reason: 'model_not_loaded' }));
  expect(await unavailable.client.profile()).toBeNull();
  await expect(fixture(() => json({ ...profileReply(), available: false })).client.profile()).rejects.toMatchObject({ code: 'invalid_result' });
});
it('submits only the fixed task, trimmed query and exactly owned JPEG, without caller-supplied prompts or URLs', async () => {
  const f = fixture(); const output = await f.client.verify({ requestId: 'verify-one', query: '  ' + query + '  ', kind: 'object', binding, profile, jpeg });
  expect(output.validated).toBe(false); expect(output.decision).toBe('match');
  const [url, options] = f.fetcher.mock.calls[0]! as unknown as [URL, RequestInit];
  expect(url.pathname).toBe('/v1/ainvr/tasks/search-verify-zh-v1');
  expect(JSON.parse(options.body as string)).toEqual({ request_id: 'verify-one', query, question_scope: 'visible',
    evidence: { kind: 'object', frame_id: binding.frame_id, sha256: sha(jpeg) }, image: { jpeg_base64: jpeg.toString('base64'), fit: 'letterbox' } });
});
it.each(['request_id', 'frame_id', 'evidence_sha256', 'query_sha256', 'input_sha256', 'template_sha256', 'preprocessing_version', 'kind', 'question_scope'])
('rejects cross-request or stale evidence field %s before returning a decision', async field => {
  const value = result() as Record<string, unknown>; value[field] = field === 'frame_id' ? randomUUID() : field === 'question_scope' ? 'temporal' : field === 'kind' ? 'scene' : 'c'.repeat(64);
  await expect(fixture(() => json(value)).client.verify({ requestId: 'verify-one', query, kind: 'object', binding, profile, jpeg })).rejects.toMatchObject({ code: 'invalid_result' });
});
it('rejects wrong model, probability-shaped invalid scores, and overlarge or unexpected response content', async () => {
  for (const value of [{ ...result(), model: { ...result().model, package_sha256: 'f'.repeat(64) } },
    { ...result(), reference_scores: { A: .9, B: .9, C: .9 } }, { ...result(), logits: { A: null, B: 1, C: 1 } }]) {
    await expect(fixture(() => json(value)).client.verify({ requestId: 'verify-one', query, kind: 'object', binding, profile, jpeg })).rejects.toMatchObject({ code: 'invalid_result' });
  }
  await expect(fixture(() => new Response('x', { headers: { 'content-type': 'text/plain' } })).client.profile()).rejects.toMatchObject({ code: 'invalid_result' });
  await expect(fixture(() => json({ padding: 'x'.repeat(17000) })).client.profile()).rejects.toBeInstanceOf(SearchVerifyLlmError);
});
it('fails closed on unavailable credentials/endpoint and never echoes private vendor errors', async () => {
  const f = fixture(); f.connection.mockResolvedValueOnce({ baseUrl: 'http://example.com:8300', inference: 's'.repeat(48), inferenceTimeoutMs: 60000 });
  await expect(f.client.profile()).rejects.toMatchObject({ code: 'task_unavailable' }); expect(f.fetcher).not.toHaveBeenCalled();
  const remote = fixture(() => json({ error: { code: 'vendor_secret_uri', message: 'mongodb://secret@private' } }, 503));
  await expect(remote.client.profile()).rejects.toMatchObject({ message: 'task_unavailable' });
});
it('cancels only the exact task request through the same dedicated caller', async () => {
  const f = fixture(() => json({ request_id: 'verify-one', cancelled: false })); expect(await f.client.cancel('verify-one')).toBe(false);
  const [url, options] = f.fetcher.mock.calls[0]! as unknown as [URL, RequestInit];
  expect(url.pathname).toBe('/v1/ainvr/tasks/search-verify-zh-v1/cancel'); expect(JSON.parse(options.body as string)).toEqual({ request_id: 'verify-one' });
  await expect(fixture(() => json({ request_id: 'different', cancelled: true })).client.cancel('verify-one')).rejects.toMatchObject({ code: 'invalid_result' });
});
it('hashes input metadata in the frozen dictionary order and query trimming never rewrites internal whitespace', () => {
  expect(searchVerifyQuerySha('  红 衣服  ')).toBe(sha('红 衣服'));
  const expected = sha('{"evidence_sha256":"' + binding.jpeg_sha256 + '","frame_id":"' + binding.frame_id + '","kind":"object","model_sha256":"' + profile.model_package_sha256 +
    '","preprocessing_version":"' + profile.preprocessing_version + '","query":"' + query + '","question_scope":"visible","template_sha256":"' + profile.template_sha256 + '"}');
  expect(searchVerifyInputSha(query, binding, profile, 'object')).toBe(expected);
});
