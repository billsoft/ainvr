import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SearchNativeClient, searchVerificationProfileFingerprint, validateSearchVerificationProfile,
  type SearchVerificationBinding, type SearchVerificationProfile, type SearchVerificationResult } from '../services/searchNativeClient.js';
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const baseProfile = { task_id: 'search-verify-zh-v1', template_sha256: 'b'.repeat(64), preprocessing_version: 'jpeg420-vpu-gles-rgb-letterbox896x448-v1',
  decision_policy: 'abc-visible-v1', model_package_id: 'qwen3vl-4b-review-v3', model_package_sha256: 'a'.repeat(64) } as const;
const profile: SearchVerificationProfile = { ...baseProfile, profile_fp: searchVerificationProfileFingerprint(baseProfile) };
const target = { search_id: id(1), actor: 'operator', version: 'c'.repeat(64), sample_id: id(2) };
const binding: SearchVerificationBinding = { ...target, frame_id: id(3), fingerprint: 'd'.repeat(64), query_sha256: hash('a red bag'),
  jpeg_sha256: 'e'.repeat(64), profile_fp: profile.profile_fp, question_scope: 'visible' };
const view = { state: 'queued', profile_fp: profile.profile_fp, request_id: null, cached: false, reason: null } as const;
const attempt = { job_id: id(9), generation: 1, request_id: 'attempt-1' };
function result(): SearchVerificationResult {
  return { schema: 'ainvr.search_verification.v1', request_id: attempt.request_id, frame_id: binding.frame_id, evidence_sha256: binding.jpeg_sha256,
    query_sha256: binding.query_sha256, input_sha256: 'f'.repeat(64), question_scope: 'visible', kind: 'object', template: baseProfile.task_id,
    template_sha256: baseProfile.template_sha256, preprocessing_version: baseProfile.preprocessing_version,
    model: { package_id: baseProfile.model_package_id, package_sha256: baseProfile.model_package_sha256 }, validated: false,
    decision_policy: baseProfile.decision_policy, score_kind: 'three_way_softmax_uncalibrated', decision: 'match', reason: 'visible_evidence',
    logits: { A: 3, B: 0, C: 0 }, reference_scores: { A: .9, B: .05, C: .05 }, timing_ms: { queue: 0, preprocess: 1, total: 2 } };
}
const inspected = { status: 'pending', binding, query: 'a red bag', kind: 'object', scope: { channel_ids: [id(4)], from_ms: Date.now() - 1000, to_ms: Date.now() + 1000 },
  expires_ms: Date.now() + 60000, verification: null, submitted: null };
function fixture(body: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
  return { fetch, client: new SearchNativeClient(async () => ({ baseUrl: 'http://127.0.0.1:8400', apiToken: 'p'.repeat(48), timeoutMs: 1000 }), fetch) };
}
describe('exact native verification transport', () => {
  it('shares the independently checked ordered-array profile fingerprint', () => {
    expect(profile.profile_fp).toBe('b094daef37bb4f3234405177c1f25a0a447a1ff5fb56b00d95e8853772cc4199');
    expect(validateSearchVerificationProfile(profile)).toEqual(profile);
    expect(() => validateSearchVerificationProfile({ ...profile, model_package_sha256: 'f'.repeat(64) })).toThrow();
  });
  it('scans only bounded single-parent references and monotonic keyset cursors', async () => {
    const f = fixture({ refs: [target], cleanup_refs: [], next_cursor: { created_ms: 10, key: 'a'.repeat(64) } });
    expect((await f.client.scanVerification(profile.profile_fp)).refs).toEqual([target]);
    const [url, init] = f.fetch.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:8400/v1/searches/verification');
    expect(init?.headers).toMatchObject({ 'x-service-token': 'p'.repeat(48) });
    expect(JSON.parse(init?.body as string)).toEqual({ action: 'scan', profile_fp: profile.profile_fp, cursor: null });
    for (const refs of [[target, target], Array.from({ length: 6 }, (_, n) => ({ ...target, sample_id: id(n + 10) })), [target, { ...target, actor: 'someone-else', sample_id: id(5) }]])
      await expect(fixture({ refs, cleanup_refs: [], next_cursor: null }).client.scanVerification(profile.profile_fp)).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(f.client.scanVerification(profile.profile_fp, { created_ms: 10, key: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('derives exact proof and query from the owned session, not caller text', async () => {
    const f = fixture(inspected); const value = await f.client.inspectVerification(target, profile);
    expect(value.binding).toEqual(binding); expect(value.query).toBe('a red bag');
    expect(value.scope?.from).toBe(new Date(inspected.scope.from_ms).toISOString());
    expect(JSON.parse(f.fetch.mock.calls[0][1]?.body as string)).toEqual({ action: 'inspect', target, profile, question_scope: 'visible' });
    for (const patch of [{ actor: 'another' }, { sample_id: id(9) }, { query_sha256: 'a'.repeat(64) }, { profile_fp: 'a'.repeat(64) }])
      await expect(fixture({ ...inspected, binding: { ...binding, ...patch } }).client.inspectVerification(target, profile)).rejects.toMatchObject({ code: 'invalid_response' });
    const badProfile = fixture(inspected);
    await expect(badProfile.client.inspectVerification(target, { ...profile, template_sha256: 'f'.repeat(64) })).rejects.toThrow();
    expect(badProfile.fetch).not.toHaveBeenCalled();
  });
  it('preserves superseded submission identity solely for cancellation, including another head slot', async () => {
    const changed = { ...baseProfile, model_package_sha256: 'f'.repeat(64) };
    const next = { ...changed, profile_fp: searchVerificationProfileFingerprint(changed) };
    const oldBinding = { ...binding, sample_id: id(8) };
    const old = { status: 'profile_superseded', binding: oldBinding, query: null, kind: null, scope: null, expires_ms: null,
      verification: { ...view, state: 'running', request_id: attempt.request_id }, submitted: attempt };
    const value = await fixture(old).client.inspectVerification(target, next);
    expect(value.status).toBe('profile_superseded'); expect(value.binding).toEqual(oldBinding); expect(value.submitted).toEqual(attempt);
    await expect(fixture({ ...old, binding: { ...oldBinding, actor: 'not-owner' } }).client.inspectVerification(target, next)).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(fixture({ ...old, query: 'must not infer' }).client.inspectVerification(target, next)).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('keeps cancelled submissions discoverable only as cleanup references and refuses inference data', async () => {
    const cleanup = fixture({ refs: [], cleanup_refs: [target], next_cursor: { created_ms: 1, key: 'a'.repeat(64) } });
    const scan = await cleanup.client.scanVerification(profile.profile_fp);
    expect(scan.refs).toEqual([]); expect(scan.cleanup_refs).toEqual([target]);
    await expect(fixture({ refs: [target], cleanup_refs: [target], next_cursor: null }).client.scanVerification(profile.profile_fp))
      .rejects.toMatchObject({ code: 'invalid_response' });
    const record = { status: 'cancelled', binding, query: null, kind: null, scope: null, expires_ms: null,
      verification: { ...view, state: 'running', request_id: attempt.request_id }, submitted: attempt };
    const cancelled = await fixture(record).client.inspectVerification(target, profile);
    expect(cancelled.status).toBe('cancelled'); expect(cancelled.submitted).toEqual(attempt); expect(cancelled.query).toBeNull();
    await expect(fixture({ ...record, query: 'must not infer' }).client.inspectVerification(target, profile)).rejects.toMatchObject({ code: 'invalid_response' });
    const cleared = await fixture({ ...record, binding: null, verification: null, submitted: null }).client.inspectVerification(target, profile);
    expect(cleared.status).toBe('cancelled'); expect(cleared.submitted).toBeNull();
  });
  it('returns submitted control identity after evidence loss without disclosing inference input', async () => {
    const record = { status: 'submitted', binding, query: null, kind: null, scope: null, expires_ms: null,
      verification: { ...view, state: 'running', request_id: attempt.request_id }, submitted: attempt };
    const value = await fixture(record).client.inspectVerification(target, profile);
    expect(value.status).toBe('submitted'); expect(value.binding).toEqual(binding); expect(value.submitted).toEqual(attempt);
    expect(value.query).toBeNull(); expect(value.scope).toBeNull();
    for (const patch of [{ query: 'must not infer' }, { kind: 'object' }, { expires_ms: Date.now() + 1000 },
      { binding: { ...binding, actor: 'another' } }, { binding: { ...binding, sample_id: id(8) } },
      { binding: { ...binding, profile_fp: 'f'.repeat(64) } }, { binding: { ...binding, question_scope: 'temporal' } },
      { submitted: { ...attempt, request_id: 'different' } }])
      await expect(fixture({ ...record, ...patch }).client.inspectVerification(target, profile)).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('adopts exact cache only through an explicit queued write and preserves the original request id', async () => {
    const queued = fixture({ stored: true, status: 'queued', verification: view, submitted: null });
    expect((await queued.client.queueVerification(binding, id(9), 0, profile)).status).toBe('queued');
    expect(JSON.parse(queued.fetch.mock.calls[0][1]?.body as string)).toEqual({ action: 'queued', binding, profile, job_id: id(9), generation: 0 });
    const cached = { ...view, state: 'match', request_id: 'original-call', cached: true, reason: 'visible_evidence' };
    const value = await fixture({ stored: true, status: 'final', verification: cached, submitted: null }).client.queueVerification(binding, id(9), 0, profile);
    expect(value.verification?.request_id).toBe('original-call'); expect(value.verification?.cached).toBe(true);
  });
  it('only reports submit after the exact durable attempt and never upgrades a repeated begin', async () => {
    const running = { ...view, state: 'running', request_id: attempt.request_id };
    const f = fixture({ stored: true, status: 'submit', verification: running, submitted: attempt });
    expect((await f.client.beginVerification(binding, attempt.job_id, 1, attempt.request_id)).status).toBe('submit');
    const duplicate = await fixture({ stored: false, status: 'already_submitted', verification: running, submitted: attempt })
      .client.beginVerification(binding, attempt.job_id, 2, 'different-attempt');
    expect(duplicate.submitted).toEqual(attempt);
    await expect(fixture({ stored: true, status: 'submit', verification: running, submitted: { ...attempt, request_id: 'other' } })
      .client.beginVerification(binding, attempt.job_id, 1, attempt.request_id)).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('binds completion to the actual query/evidence/profile and rejects extra payload fields before HTTP', async () => {
    const complete = { ...view, state: 'match', request_id: attempt.request_id, reason: 'visible_evidence' };
    const f = fixture({ stored: true, status: 'final', verification: complete, submitted: null });
    expect((await f.client.finishVerification(binding, attempt.job_id, 1, attempt.request_id, result())).stored).toBe(true);
    for (const bad of [{ ...result(), query_sha256: 'a'.repeat(64) }, { ...result(), evidence_sha256: 'a'.repeat(64) },
      { ...result(), validated: true }, { ...result(), jpeg_base64: 'never store this' }, { ...result(), reference_scores: { A: 1, B: 1, C: 1 } }]) {
      const refused = fixture({});
      await expect(refused.client.finishVerification(binding, attempt.job_id, 1, attempt.request_id, bad as never)).rejects.toThrow();
      expect(refused.fetch).not.toHaveBeenCalled();
    }
    await expect(fixture({ stored: true, status: 'final', verification: { ...complete, cached: true }, submitted: null })
      .client.finishVerification(binding, attempt.job_id, 1, attempt.request_id, result())).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('aborts the exact old unknown submission without re-encoding, recomputing or exposing model inputs', async () => {
    const final = { ...view, state: 'unavailable', request_id: attempt.request_id, reason: 'already_submitted' };
    const f = fixture({ stored: true, status: 'final', verification: final, submitted: null });
    await f.client.abortVerification(binding, attempt.job_id, 2, attempt.request_id, 'already_submitted');
    expect(JSON.parse(f.fetch.mock.calls[0][1]?.body as string)).toEqual({ action: 'abort', binding, job_id: attempt.job_id,
      generation: 2, request_id: attempt.request_id, reason: 'already_submitted' });
    expect(JSON.stringify(f.fetch.mock.calls[0])).not.toContain('a red bag');
    const bad = fixture({}); await expect(bad.client.abortVerification(binding, attempt.job_id, 2, attempt.request_id, 'private-driver-error' as never)).rejects.toThrow();
    expect(bad.fetch).not.toHaveBeenCalled();
  });
});
