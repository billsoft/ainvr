import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { FacesStore } from '../store/facesStore.js';
import type { FacesTemplate } from '../services/facesContract.js';
const uri = process.env.AINVR_FACES_TEST_PG_URI;
describe.skipIf(!uri)('Faces PG isolated schema', () => {
  const schema = `faces_test_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool, pool: Pool, store: FacesStore;
  beforeAll(async () => {
    admin = new Pool({ connectionString: uri, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: uri, max: 2, options: `-c search_path=${schema},pg_catalog` }); store = new FacesStore(pool);
    await pool.query('CREATE TABLE config_audit_logs(actor text,action text,service text,"group" text,config_name text,version_before integer,version_after integer,detail jsonb)');
    await pool.query(await readFile(new URL('../store/migrations/030_faces.sql', import.meta.url), 'utf8'));
  });
  afterAll(async () => { await pool?.end(); if (admin) { if (!/^faces_test_[a-f0-9]{32}$/.test(schema)) throw Error('Unsafe schema'); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });
  const document = (count = 0) => ({ name: 'Test', model: 'mbf', channel_ids: [randomUUID()], valid_until: new Date(Date.now() + 86400000).toISOString(), retention_days: 7, access: 'console-management', members: Array.from({ length: count }, () => ({ id: randomUUID(), name: 'Member', note: '', template_id: null })) });
  it('same request is idempotent; concurrent CAS only accepts one writer; old receipt cannot replace latest', async () => {
    const id = randomUUID(), key = randomUUID(), body = { expected_version: 0, document: document() };
    const saved = await store.save(id, body, {}, 'console-administrator', key);
    expect((await store.save(id, body, {}, 'console-administrator', key)).version).toBe(saved.version);
    const results = await Promise.allSettled(['A', 'B'].map(name => store.save(id, { expected_version: 1, document: { ...body.document, name } }, {}, 'console-administrator', randomUUID())));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    await expect(store.save(id, body, {}, 'console-administrator', key)).rejects.toMatchObject({ code: 'operation_superseded' });
    const latest = await store.get(id); expect(latest.version).toBe(2);
    expect((await pool.query('SELECT count(*)::int AS n FROM faces_library_versions WHERE library_id=$1', [id])).rows[0].n).toBe(2);
    await store.delete(id, { expected_version: 2 }, 'console-administrator', randomUUID());
  });
  it('500 members is a device total, deleted configuration releases active quota', async () => {
    const id = randomUUID(); await store.save(id, { expected_version: 0, document: document(500) }, {}, 'console-administrator', randomUUID());
    await expect(store.save(randomUUID(), { expected_version: 0, document: document(1) }, {}, 'console-administrator', randomUUID())).rejects.toMatchObject({ code: 'faces_capacity' });
    await store.delete(id, { expected_version: 1 }, 'console-administrator', randomUUID());
    const fresh = await store.save(randomUUID(), { expected_version: 0, document: document(1) }, {}, 'console-administrator', randomUUID()); expect(fresh.version).toBe(1);
  });
  it('a conflicting active model is rejected transactionally without changing existing configuration', async () => {
    const id = randomUUID(), before = await store.list();
    await expect(store.save(id, { expected_version: 0, document: { ...document(), model: 'r50' } }, {}, 'console-administrator', randomUUID())).rejects.toMatchObject({ code: 'faces_model_conflict', statusCode: 409 });
    expect(await store.list()).toEqual(before);
    await expect(store.get(id)).rejects.toMatchObject({ code: 'faces_library_missing' });
  });
  it('reads the actual historical member template after replacement and deletion, independent of business validity', async () => {
    const id = randomUUID(), memberId = randomUUID(), firstTemplateId = randomUUID(), secondTemplateId = randomUUID();
    const template: FacesTemplate = {
      template_id: firstTemplateId, photo_ref: firstTemplateId, request_id: firstTemplateId,
      actor: 'console-administrator', library_id: id, member_id: memberId, model: 'mbf', space_id: 'a'.repeat(64),
      quality: { state: 'qualified', reason: 'synthetic_geometry_only' }, jpeg_sha256: 'b'.repeat(64),
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    };
    const firstDocument = { ...document(), name: 'Historical library', valid_until: new Date(Date.now() - 1000).toISOString(), members: [{ id: memberId, name: 'Historical member', note: 'version one', template_id: firstTemplateId }] };
    const first = await store.save(id, { expected_version: 0, document: firstDocument }, { [memberId]: template }, 'console-administrator', randomUUID());
    const replacement = { ...template, template_id: secondTemplateId, photo_ref: secondTemplateId, request_id: secondTemplateId, space_id: 'c'.repeat(64), jpeg_sha256: 'd'.repeat(64) };
    const second = await store.save(id, { expected_version: 1, document: { ...firstDocument, name: 'Renamed library', members: [{ id: memberId, name: 'Renamed member', note: 'version two', template_id: secondTemplateId }] } }, { [memberId]: replacement }, 'console-administrator', randomUUID());
    const historical = await store.getVersion(id, 1), currentVersion = await store.getVersion(id, 2);
    expect(historical.document).toEqual(first.document); expect(historical.templates).toEqual(first.templates);
    expect(historical.templates[memberId]).toEqual(template);
    expect(currentVersion.document).toEqual(second.document); expect(currentVersion.templates[memberId]).toEqual(replacement);
    expect(Date.parse(historical.retain_until)).toBeGreaterThan(Date.now());
    expect(Date.parse(historical.document.valid_until)).toBeLessThan(Date.now());
    await store.delete(id, { expected_version: 2 }, 'console-administrator', randomUUID());
    await expect(store.get(id)).rejects.toMatchObject({ code: 'faces_library_missing' });
    expect((await store.getVersion(id, 1)).templates[memberId]).toEqual(template);
    expect((await store.getVersion(id, 2)).templates[memberId]).toEqual(replacement);
    // Version reads never rewrite a photo reference or copy it into current state.
    const deleted = (await pool.query('SELECT templates FROM faces_libraries WHERE id=$1', [id])).rows[0];
    expect(deleted.templates).toEqual({});
  });
  it('historical version retention is enforced without latest-version fallback or extending a photo expiry', async () => {
    const id = randomUUID(), memberId = randomUUID(), templateId = randomUUID();
    const template: FacesTemplate = { template_id: templateId, photo_ref: templateId, request_id: templateId, actor: 'console-administrator', library_id: id, member_id: memberId, model: 'mbf', space_id: 'a'.repeat(64), quality: { state: 'qualified', reason: null }, jpeg_sha256: 'b'.repeat(64), expires_at: new Date(Date.now() - 1000).toISOString() };
    const input = { ...document(), members: [{ id: memberId, name: 'Member', note: '', template_id: templateId }] };
    await store.save(id, { expected_version: 0, document: input }, { [memberId]: template }, 'console-administrator', randomUUID());
    await store.save(id, { expected_version: 1, document: { ...input, members: [] } }, {}, 'console-administrator', randomUUID());
    // Store preserves original template expiry; the service photo gate rejects it.
    expect((await store.getVersion(id, 1)).templates[memberId].expires_at).toBe(template.expires_at);
    expect((await store.getVersion(id, 2)).templates).toEqual({});
    const before = (await pool.query('SELECT * FROM faces_library_versions WHERE library_id=$1 ORDER BY version', [id])).rows;
    await store.getVersion(id, 1); await store.getVersion(id, 2);
    expect((await pool.query('SELECT * FROM faces_library_versions WHERE library_id=$1 ORDER BY version', [id])).rows).toEqual(before);
    await pool.query("UPDATE faces_library_versions SET retain_until=now()-interval '1 second' WHERE library_id=$1 AND version=1", [id]);
    await expect(store.getVersion(id, 1)).rejects.toMatchObject({ code: 'evidence_expired', statusCode: 410 });
    await expect(store.getVersion(id, 999)).rejects.toMatchObject({ code: 'evidence_expired', statusCode: 410 });
    await expect(store.getVersion(randomUUID(), 1)).rejects.toMatchObject({ code: 'evidence_expired', statusCode: 410 });
    expect((await store.getVersion(id, 2)).templates).toEqual({});
    await store.delete(id, { expected_version: 2 }, 'console-administrator', randomUUID());
  });
});
