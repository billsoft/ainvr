import { expect, it, vi } from 'vitest';
import { llmSettingsSchema } from '../store/llmConfigAdapter.js';
import { prepareSearchVerifyLlmConfiguration } from '../services/searchVerifyConfiguration.js';
const settings = () => ({ enabled: false, listen: { host: '127.0.0.1', port: 8300 }, admin_key: '${secret:llm-service/admin/v1}',
  api_keys: [{ name: 'alarm-review', scope: 'inference', key: '${secret:llm-service/alarm/v1}' }],
  model: { package_id: 'qwen3vl-4b-review-v3', load_policy: 'resident', ion_reserve_mb: 512 },
  tasks: { 'alarm-review-zh-v1': { calibration_temperature: 1, aspect_policy: 'reject' } },
  scheduling: { queue_size: 8, queue_timeout_s: 30, exec_timeout_s: 10, submit_time_share_cap_percent: 40, prefill_profile: 's256' }, logging: { record_requests: false } });
it('old LLM settings remain valid and the independent search task is optional and strict', () => {
  expect(llmSettingsSchema.safeParse(settings()).success).toBe(true);
  expect(llmSettingsSchema.safeParse({ ...settings(), tasks: { ...settings().tasks, 'search-verify-zh-v1': { enabled: false, aspect_policy: 'letterbox', decision_policy: 'abc-visible-v1' } } }).success).toBe(true);
  expect(llmSettingsSchema.safeParse({ ...settings(), tasks: { ...settings().tasks, 'search-verify-zh-v1': { enabled: true, aspect_policy: 'reject', decision_policy: 'alarm-threshold' } } }).success).toBe(false);
});
it('prepares only a new encrypted caller and task, preserving the entire original configuration and references', async () => {
  const original = settings(), encryptSecret = vi.fn((_plain: string) => Buffer.from('encrypted-fixture')), query = vi.fn(async (_sql: string, _parameters?: unknown[]) => ({}));
  const prepared = await prepareSearchVerifyLlmConfiguration({ encryptSecret }, { query } as never, original);
  expect(prepared.changed).toBe(true); expect(original).toEqual(settings()); expect(prepared.settings.enabled).toBe(false);
  expect(prepared.settings.api_keys[0]).toEqual(original.api_keys[0]); expect(prepared.settings.admin_key).toBe(original.admin_key);
  expect(prepared.settings.model).toEqual(original.model); expect(prepared.settings.scheduling).toEqual(original.scheduling);
  expect(prepared.settings.tasks['alarm-review-zh-v1']).toEqual(original.tasks['alarm-review-zh-v1']);
  expect(prepared.settings.api_keys[1]).toMatchObject({ name: 'search-verify', scope: 'inference' });
  expect(prepared.settings.api_keys[1]!.key).toMatch(/^\$\{secret:llm-service\/api_keys.search-verify\/[a-f0-9-]+\}$/);
  expect(encryptSecret).toHaveBeenCalledTimes(1); expect(encryptSecret.mock.calls[0]![0]).toMatch(/^[a-f0-9]{96}$/);
  expect(query).toHaveBeenCalledTimes(1); expect(query.mock.calls[0]![1]).toContainEqual(Buffer.from('encrypted-fixture'));
  const again = await prepareSearchVerifyLlmConfiguration({ encryptSecret }, { query } as never, prepared.settings);
  expect(again.changed).toBe(false); expect(again.settings).toEqual(prepared.settings); expect(query).toHaveBeenCalledTimes(1);
});
it('respects an existing disabled task and fails before writing when caller capacity is full', async () => {
  const query = vi.fn(), encryptSecret = vi.fn(() => Buffer.alloc(1));
  const full = { ...settings(), api_keys: Array.from({ length: 16 }, (_, n) => ({ name: 'caller-' + n, scope: 'inference', key: '${secret:llm-service/caller/' + n + '}' })) };
  await expect(prepareSearchVerifyLlmConfiguration({ encryptSecret }, { query } as never, full)).rejects.toThrow('llm_caller_capacity');
  expect(query).not.toHaveBeenCalled(); expect(encryptSecret).not.toHaveBeenCalled();
  const input = { ...settings(), api_keys: [...settings().api_keys, { name: 'search-verify', scope: 'inference', key: '${secret:llm-service/search/v1}' }],
    tasks: { ...settings().tasks, 'search-verify-zh-v1': { enabled: false, aspect_policy: 'letterbox', decision_policy: 'abc-visible-v1' } } };
  expect((await prepareSearchVerifyLlmConfiguration({ encryptSecret }, { query } as never, input)).settings.tasks['search-verify-zh-v1']?.enabled).toBe(false);
});
