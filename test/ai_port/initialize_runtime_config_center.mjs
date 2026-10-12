// Copyright AINVR. Initialize the copied configuration center through its original store.
// Existing user documents are never overwritten. Credentials stay on the board.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { PgConfigStore } from '../../srs-web-console/backend/dist/store/pgStore.js';
import { PublishOrchestrator } from '../../srs-web-console/backend/dist/store/publishOrchestrator.js';
import { PullModeAdapter } from '../../srs-web-console/backend/dist/store/adapter.js';
import { sanitizeImportDocSecrets } from '../../srs-web-console/backend/dist/routes/configPolicy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
assert.equal(fs.realpathSync(root), '/home/sunrise/ainvr');
const env = Object.fromEntries(fs.readFileSync(path.join(root, 'deploy/s100p/runtime/backend.env'), 'utf8')
  .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
  .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^(["'])(.*)\1$/, '$2')]));
assert.ok(fs.existsSync(env.CONFIG_MASTER_KEY_PATH), 'Existing configuration master key required');
const store = new PgConfigStore({ poolConfig: {
  host: env.CONFIG_PG_HOST, port: Number(env.CONFIG_PG_PORT), user: env.CONFIG_PG_USER,
  password: env.CONFIG_PG_PASSWORD, database: env.CONFIG_PG_DATABASE,
}, masterKeyPath: env.CONFIG_MASTER_KEY_PATH });
const state = async () => (await store.pool.query(
  'SELECT service_name,desired_version,applied_version,status,restart_required FROM config_service_states ORDER BY service_name')).rows;
const beforeStates = await state();
try {
  const existing = await store.pool.query('SELECT service,"group",name FROM config_documents WHERE service=$1', ['ai-service']);
  if (process.argv.includes('--inspect')) {
    console.log(JSON.stringify({ documents: existing.rows, states: beforeStates }));
    process.exitCode = 0;
  } else {
    assert.equal(existing.rowCount, 0, 'AI configuration already exists; reconcile instead of overwriting');
    const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
    const base = read('deploy/s100p/runtime/ai-service.json');
    const overlay = read('data/ai/config_overlay.json');
    const snapshot = { ...base.snapshot_store, ...overlay.snapshot_store };
    const apiKey = overlay.server?.api_key ?? base.server.api_key;
    assert.ok(snapshot.mongo_uri && snapshot.db_name && apiKey);
    for (const [key, value] of [['ai-service/snapshot_store.mongo_uri', snapshot.mongo_uri], ['ai-service/server.api_key', apiKey]]) {
      const prior = await store.getSecret(key);
      assert.ok(prior == null || prior === value, 'Existing service secret differs; reconcile before initialization');
    }
    const controller = new PublishOrchestrator(store, [new PullModeAdapter('ai-service')]);
    const actor = 'AINVR S100P deployment';
    const published = await controller.publish('接入 AI 服务配置同步；保留当前归档与通道设置', actor, {
      services: ['ai-service'],
      prepare: async client => {
        const check = await client.query('SELECT id FROM config_documents WHERE service=$1 FOR UPDATE', ['ai-service']);
        assert.equal(check.rowCount, 0, 'Concurrent AI settings change detected');
        const config = await sanitizeImportDocSecrets('ai-service', { snapshot_store: snapshot, server: { api_key: apiKey } }, store, actor, client);
        assert.ok(config.snapshot_store.mongo_uri.startsWith('${secret:ai-service/'));
        assert.ok(config.server.api_key.startsWith('${secret:ai-service/'));
        await client.query('INSERT INTO config_documents(service,"group",name,config,description) VALUES($1,$2,$3,$4,$5)',
          ['ai-service', 'system', 'settings', JSON.stringify(config), 'AINVR AI 归档配置，沿用当前运行值']);
        await store.addAuditLog({ actor, action: 'update', service: 'ai-service', group: 'system', configName: 'settings' }, client);
      },
    });
    assert.equal(published.overallStatus, 'all_pending');
    const version = published.version.version;
    const deadline = Date.now() + 45000;
    let states;
    while (true) {
      states = await state();
      const ai = states.find(s => s.service_name === 'ai-service');
      if (Number(ai.applied_version) === version && ai.status === 'applied') {
        assert.equal(ai.restart_required, false, 'Same-value configuration should not require restart');
        break;
      }
      assert.ok(Date.now() < deadline, 'Published configuration not acknowledged; inspect live service');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.deepEqual(states.filter(s => s.service_name !== 'ai-service'), beforeStates.filter(s => s.service_name !== 'ai-service'));
    const doc = (await store.pool.query('SELECT config FROM config_documents WHERE service=$1', ['ai-service'])).rows[0].config;
    assert.ok(doc.snapshot_store.mongo_uri.startsWith('${secret:ai-service/'));
    assert.ok(doc.server.api_key.startsWith('${secret:ai-service/'));
    const report = { passed: true, version, states, original_publish_transaction: true,
      mongo_credentials_encrypted: true, same_runtime_settings: true, other_services_unchanged: true };
    fs.writeFileSync(path.join(root, 'test/results/runtime-config-center-live-20261012.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(report));
  }
} finally {
  await store.close();
}
