// Real PG + production config/index routes. ACKs are explicitly simulated;
// the access file remains software-preflight and cannot authorize a BPU client.
import { readFileSync, writeFileSync, realpathSync, lstatSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runManagedParameterFixture } from './managed_parameter_fixture.mjs';
if (process.argv.length !== 4 || process.argv[2] !== '--run-software-preflight' || process.env.AINVR_SEARCH_TEST_PG !== '1')
  throw new Error('explicit_software_preflight_required');
const root = realpathSync(new URL('../..', import.meta.url)), directory = realpathSync(resolve(process.argv[3]!));
const options = JSON.parse(readFileSync(resolve(directory, 'managed-options.json'), 'utf8'));
if (options.mode !== 'software-preflight') throw new Error('software_mode_required');
let checks = 0;
function check(value: unknown, reason: string) { ++checks; if (!value) throw new Error(reason); }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const fixture = await runManagedParameterFixture(root, directory);
try {
  const admin = JSON.parse(readFileSync(resolve(directory, 'fixture-admin.json'), 'utf8'));
  const bootstrap = JSON.parse(readFileSync(resolve(directory, 'search-service-bootstrap.json'), 'utf8'));
  check(bootstrap.control_url === 'http://127.0.0.1:25441', 'bootstrap_endpoint');
  check((lstatSync(resolve(directory, 'search-service-bootstrap.json')).mode & 0o777) === 0o600, 'private_bootstrap_mode');
  const management = { 'x-service-token': bootstrap.service_token }, producer = { 'x-service-token': admin.ai_service_token };
  const administrator = { 'x-fixture-admin': admin.admin_token };
  async function request(path: string, headers: Record<string, string>, body?: unknown) {
    const response = await fetch('http://127.0.0.1:25441' + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(5000) });
    const text = await response.text(); check(text.length <= 65536, 'response_bound');
    return { status: response.status, body: JSON.parse(text) };
  }
  async function waitFor(test: () => Promise<boolean>, reason: string) {
    const end = Date.now() + 6000;
    while (Date.now() < end) { if (await test()) return; await sleep(25); }
    throw new Error(reason);
  }
  const access = () => JSON.parse(readFileSync(resolve(directory, 'client-access.json'), 'utf8'));
  async function current() {
    const response = await request('/api/internal/search/runtime-config', management);
    check(response.status === 200, 'runtime_config_status'); return response.body;
  }
  async function acknowledge(config: any) {
    const reply = await request('/api/internal/search/runtime-state', management,
      { desired_version: config.desired_version, revision: config.revision, status: 'applied' });
    check(reply.status === 200 && reply.body.ok, 'production_runtime_ack');
    await waitFor(async () => access().revision === config.revision, 'access_not_refreshed_after_ack');
  }
  async function operation(id: string) {
    await waitFor(async () => (await request('/api/v1/config/apply?id=' + id, administrator)).body.data?.status === 'succeeded', 'apply_operation_not_finished');
  }
  const first = await current();
  check(first.settings.enabled && first.settings.model.package_id === 'siglip2-base-full-int8', 'published_default_model');
  check(first.dependency_status === null && first.index_directory.ready, 'metadata_dependencies_ready');
  check(first.history_connection.uri === 'mongodb://127.0.0.1:25440', 'isolated_history_uri');
  check(first.index_directory.volume_id === options.volume_id && first.index_directory.relative_path === options.relative_path, 'authorized_directory');
  check(!existsSync(first.index_directory.resolved_path), 'software_created_ssd_directory');
  check(first.sources.length === 1 && first.sources[0].processor_id === 'search-bpu-fixture' && first.sources[0].input_path === '/live/search-fixture-raw', 'real_source_catalog');
  check((await request('/api/internal/search/runtime-config', producer)).status === 403, 'producer_cannot_read_management');
  check((await request('/api/internal/search/producer-config', management)).status === 403, 'manager_cannot_read_producer');
  const pending = (await request('/api/internal/search/producer-config', producer)).body;
  check(!pending.enabled && pending.reason === 'config_pending' && pending.api_token === null, 'pending_grant_leak');
  check(!access().enabled && access().producer === null, 'pending_file_leak');
  const state1 = (await request('/fixture/state', administrator)).body;
  check(state1.search_callers_encrypted && state1.history_connection_encrypted, 'secret_refs_not_real');
  const wrong = await request('/api/internal/search/runtime-state', management,
    { desired_version: first.desired_version, revision: '0'.repeat(64), status: 'applied' });
  check(wrong.status === 409, 'invalid_ack_accepted');
  await acknowledge(first);
  check(access().fixture_mode === 'software-preflight' && !access().enabled, 'software_access_mode');
  const grant1 = (await request('/api/internal/search/producer-config', producer)).body;
  check(!grant1.enabled && grant1.reason === 'config_pending' && grant1.api_token === null, 'no_model_pin_no_producer_grant');
  check(access().console === null && access().producer === null && access().revision === first.revision, 'software_ack_is_not_native_ready');
  check((await current()).active_model_pin === null, 'software_did_not_fabricate_model_pin');
  const catalog = { action: 'catalog', revision: first.revision, model_version: 'search-v1-' + 'a'.repeat(64), cursor: null, limit: 1 };
  check((await request('/api/internal/search/index-jobs', management, catalog)).status === 503, 'index_without_native_model_pin');
  // Initial ConfigApply operation is real and must observe this ACK as well.
  await waitFor(async () => (await request('/api/v1/config/apply', administrator)).body.data?.status === 'succeeded', 'initial_apply_pending');

  const disabled = await request('/fixture/control', administrator, { action: 'disable' });
  check(disabled.status === 200, 'disable_control');
  check(!access().enabled && access().console === null && access().producer === null, 'disable_did_not_revoke_file');
  const config2 = await current(); check(config2.desired_version > first.desired_version && !config2.settings.enabled, 'disable_not_published');
  check((await request('/api/internal/search/runtime-state', management,
    { desired_version: first.desired_version, revision: first.revision, status: 'applied' })).status === 409, 'late_ack_not_rejected');
  await acknowledge(config2); await operation(disabled.body.apply_id);
  check((await request('/api/internal/search/producer-config', producer)).body.reason === 'disabled', 'disabled_grant');

  const enabled = await request('/fixture/control', administrator, { action: 'enable' }); check(enabled.status === 200, 'enable_control');
  const config3 = await current(); await acknowledge(config3); await operation(enabled.body.apply_id);
  const grant3 = (await request('/api/internal/search/producer-config', producer)).body;
  check(!grant3.enabled && grant3.api_token === null, 'enable_did_not_fabricate_model_ready');
  check(config3.settings.callers.find((caller: any) => caller.scope === 'producer').key ===
    first.settings.callers.find((caller: any) => caller.scope === 'producer').key, 'caller_rotated_on_save');
  const changed = await request('/fixture/control', administrator, { action: 'source_generation' }); check(changed.status === 200, 'source_control');
  check(!access().enabled && access().producer === null, 'source_revision_did_not_revoke');
  const config4 = await current();
  check(config4.desired_version === config3.desired_version && config4.revision !== config3.revision, 'dependency_revision_not_real');
  check(config4.sources[0].channel_id === config3.sources[0].channel_id && config4.sources[0].input_path === '/live/search-fixture-raw_g2', 'source_binding_not_updated');
  check((await request('/api/internal/search/runtime-state', management,
    { desired_version: config3.desired_version, revision: config3.revision, status: 'applied' })).status === 409, 'old_dependency_ack_accepted');
  await acknowledge(config4);
  check((await request('/api/internal/search/index-jobs', management, { ...catalog, revision: config3.revision })).status === 503, 'model_pending_index_request_accepted');
  check(!access().enabled && access().producer === null && config4.sources[0].output_path === '/live/search-fixture-ai_g2', 'source_updated_without_fake_model_ready');
  check(!existsSync(first.index_directory.resolved_path), 'software_ssd_write');
  const report = { passed: true, checks, real_pg: true, real_config_store: true, real_runtime_and_index_routes: true,
    encrypted_callers_and_history: true, desired_and_ack_verified: true, disable_revoked: true, dependency_revision_revoked: true,
    caller_preserved: true, storage_inventory_read_only: true, ssd_directory_created: false,
    runtime_ack_simulated: true, model_pin_not_fabricated: true, producer_pending_without_native_ready: true,
    index_pending_without_native_ready: true,
    native_executed: false, bpu_executed: false, fixture_mode: 'software-preflight' };
  writeFileSync(resolve(directory, 'software-preflight.json'), JSON.stringify(report) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report));
} finally { await fixture.close(); }
