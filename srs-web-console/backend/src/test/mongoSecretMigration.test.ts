import { describe, it, expect, vi } from 'vitest';
import { PgConfigStore } from '../store/pgStore.js';

describe('legacy Mongo credentials migration', () => {
  it('encrypts documents and each historical snapshot independently and is idempotent', async () => {
    const rows = { config_documents: [{ id: 1, config: { snapshot_store: { mongo_uri: 'mongodb://current', mongo_readonly_password: 'current-pass' } } }],
      config_snapshots: [{ id: 2, config: { snapshot_store: { mongo_uri: 'mongodb://historical', mongo_readonly_password: 'old-pass' } } }] };
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith('SELECT id, config') ? (sql.includes('config_documents') ? rows.config_documents : rows.config_snapshots) : [] }));
    const encrypt = vi.fn((value: string) => Buffer.from('encrypted:' + value));
    const release = vi.fn();
    const store = Object.assign(Object.create(PgConfigStore.prototype), { pool: { connect: async () => ({ query, release }) }, crypto: { encrypt } });
    await store.migrateMongoSecrets();
    expect(encrypt.mock.calls.map(c => c[0])).toEqual(['mongodb://current', 'current-pass', 'mongodb://historical', 'old-pass']);
    expect(rows.config_documents[0].config.snapshot_store.mongo_uri).toContain('legacy-config_documents-1');
    expect(rows.config_snapshots[0].config.snapshot_store.mongo_uri).toContain('legacy-config_snapshots-2');
    await store.migrateMongoSecrets();
    expect(encrypt).toHaveBeenCalledTimes(4);
    expect(release).toHaveBeenCalledTimes(2);
  });
});
