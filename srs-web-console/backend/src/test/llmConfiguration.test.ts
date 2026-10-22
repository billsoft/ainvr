import {expect, it, vi} from 'vitest';
import {sanitizeImportDocSecrets, validateNoSensitiveFields} from '../routes/configPolicy.js';
import {readAppliedLlmConnection} from '../services/llmConnection.js';
import {llmSettingsSchema} from '../store/llmConfigAdapter.js';

it('stores each caller secret separately and preserves previous references on rotation', async () => {
  const secrets = new Map<string, string>();
  const store = {setSecret: async (key: string, value: string) => {secrets.set(key, value);}};
  const input = {admin_key: 'admin'.repeat(8), api_keys: [
    {name: 'alarm-service', scope: 'inference', key: 'alarm'.repeat(8)},
    {name: 'console-try', scope: 'inference', key: 'console'.repeat(8)},
  ]};
  const first = await sanitizeImportDocSecrets('llm-service', input, store as never, 'operator');
  expect(secrets.size).toBe(3);
  expect(JSON.stringify(first)).not.toContain(input.admin_key);
  expect(JSON.stringify(first)).not.toContain(input.api_keys[0].key);
  expect(input.api_keys[0].key).toBe('alarm'.repeat(8));
  expect(await sanitizeImportDocSecrets('llm-service', first, store as never, 'operator')).toEqual(first);
  expect(secrets.size).toBe(3);
  const second = await sanitizeImportDocSecrets('llm-service', input, store as never, 'operator');
  expect(second).not.toEqual(first);
  expect(secrets.size).toBe(6);
});

it('still rejects undeclared plaintext secrets inside arrays', () => {
  expect(validateNoSensitiveFields({other: [{password: 'plain'}]}, 'llm-service')).toContain('other.0.password');
});

it('uses the applied version and fails closed if that version changes mid-read', async () => {
  const state = vi.fn(async () => ({appliedVersion: 2, desiredVersion: 3}));
  const docs = vi.fn(async () => [{group: 'system', name: 'settings', config: {
    admin_key: '${secret:llm-service/admin_key/v2}',
    api_keys: [{name: 'console-try', key: '${secret:llm-service/api_keys.0.key/v2}'}],
  }}]);
  const secret = vi.fn(async (name: string) => `resolved-${name}`);
  const store = {getServiceState: state, getVersionSnapshotForService: docs, getSecret: secret};
  expect((await readAppliedLlmConnection(store as never, '127.0.0.1'))?.baseUrl).toBe('http://127.0.0.1:8300');
  expect(docs).toHaveBeenCalledWith(2, 'llm-service');
  state.mockResolvedValueOnce({appliedVersion: 2, desiredVersion: 3})
    .mockResolvedValueOnce({appliedVersion: 3, desiredVersion: 3});
  expect(await readAppliedLlmConnection(store as never)).toBeNull();
});

const settings = () => ({
  enabled: false, listen: {host: '127.0.0.1', port: 8300},
  admin_key: 'a'.repeat(32), api_keys: [{name: 'console-try', scope: 'inference', key: 'b'.repeat(32)}],
  model: {package_id: 'qwen3vl-4b-review-v3', load_policy: 'resident', ion_reserve_mb: 512},
  tasks: {'alarm-review-zh-v1': {calibration_temperature: 1, aspect_policy: 'reject'}},
  scheduling: {queue_size: 8, queue_timeout_s: 30, exec_timeout_s: 10, submit_time_share_cap_percent: 40, prefill_profile: 's256'},
  logging: {record_requests: false},
});

it('accepts the fixed task configuration and rejects unsupported profiles and duplicate credentials', () => {
  expect(llmSettingsSchema.safeParse(settings()).success).toBe(true);
  const duplicate = settings(); duplicate.api_keys[0]!.key = duplicate.admin_key;
  expect(llmSettingsSchema.safeParse(duplicate).success).toBe(false);
  const profile = settings(); profile.scheduling.prefill_profile = 's512';
  expect(llmSettingsSchema.safeParse(profile).success).toBe(false);
  const listen = settings(); listen.listen.host = '0.0.0.0';
  expect(llmSettingsSchema.safeParse(listen).success).toBe(false);
});
