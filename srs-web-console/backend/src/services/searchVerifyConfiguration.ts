import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { PgConfigStore } from '../store/pgStore.js';
import { llmSettingsSchema } from '../store/llmConfigAdapter.js';

/** Preparation step for the existing config publish transaction. This function
 * never publishes, changes service versions, or modifies an existing credential.
 * The caller must persist the returned settings and encrypted secret atomically. */
export async function prepareSearchVerifyLlmConfiguration(store: Pick<PgConfigStore, 'encryptSecret'>,
  client: Pick<PoolClient, 'query'>, input: unknown, previous?: unknown) {
  const settings = llmSettingsSchema.parse(input);
  const old = llmSettingsSchema.safeParse(previous);
  let changed = false;
  if (!settings.tasks['search-verify-zh-v1']) {
    settings.tasks['search-verify-zh-v1'] = old.success && old.data.tasks['search-verify-zh-v1']
      ? old.data.tasks['search-verify-zh-v1'] : { enabled: true, aspect_policy: 'letterbox', decision_policy: 'abc-visible-v1' };
    changed = true;
  }
  if (!settings.api_keys.some(caller => caller.name === 'search-verify')) {
    if (settings.api_keys.length >= 16) throw new Error('llm_caller_capacity');
    const existing = old.success ? old.data.api_keys.find(caller => caller.name === 'search-verify') : null;
    if (existing) {
      settings.api_keys.push(existing);
      return { settings: llmSettingsSchema.parse(settings), changed: true };
    }
    const path = `llm-service/api_keys.search-verify/${randomUUID()}`;
    const encrypted = await store.encryptSecret(randomBytes(48).toString('hex'));
    await client.query(`INSERT INTO config_secrets(key_path,ciphertext,algorithm,key_version)
      VALUES($1,$2,'aes-256-gcm',1)`, [path, encrypted]);
    settings.api_keys.push({ name: 'search-verify', scope: 'inference', key: '${secret:' + path + '}' });
    changed = true;
  }
  return { settings: llmSettingsSchema.parse(settings), changed };
}
