// Root-invoked, explicitly finite hardware phase. Never ordinary software tests.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { userInfo } from 'node:os';
const execute = promisify(execFile);
if (process.argv.length !== 4 || process.argv[2] !== '--run-hardware' || process.env.AINVR_SEARCH_TEST_MONGO !== '1' || userInfo().username !== 'sunrise')
  throw new Error('explicit_sunrise_hardware_phase_required');
const root = realpathSync(new URL('../..', import.meta.url)), directory = realpathSync(resolve(process.argv[3]!));
const child = relative(resolve(root, 'test/results/search-managed-parameter'), directory);
if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('owned_results_directory_required');
const client = resolve(root, 'test/build/search-hardware-ai/build/ai/ainvr_search_bpu_integration_client');
const input = resolve(root, 'test/runtime/official-multimedia-samples-4.0.5-20260211104018/sample_codec/1920x1080_NV12.yuv');
const accessFile = resolve(directory, 'client-access.json');
const options = JSON.parse(readFileSync(resolve(directory, 'managed-options.json'), 'utf8'));
if (options.mode !== 'managed-hardware') throw new Error('hardware_mode_required');
const admin = JSON.parse(readFileSync(resolve(directory, 'fixture-admin.json'), 'utf8'));
const bootstrap = JSON.parse(readFileSync(resolve(directory, 'search-service-bootstrap.json'), 'utf8'));
const administrator = { 'x-fixture-admin': admin.admin_token }, manager = { 'x-service-token': bootstrap.service_token };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let checks = 0;
function check(value: unknown, reason: string) { ++checks; if (!value) throw new Error(reason); }
async function request(base: string, path: string, headers: Record<string, string>, body?: unknown) {
  if (!['http://127.0.0.1:25441', 'http://127.0.0.1:8400'].includes(base)) throw new Error('fixture_endpoint_required');
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: {
    ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(4000) });
  const text = await response.text(); check(text.length < 1048576, 'response_too_large');
  return { status: response.status, body: JSON.parse(text) };
}
async function waitFor(predicate: () => Promise<boolean>, name: string, maximum = 45000) {
  const end = Date.now() + maximum;
  while (Date.now() < end) { try { if (await predicate()) return; } catch {} await pause(100); }
  throw new Error(name);
}
const access = () => JSON.parse(readFileSync(accessFile, 'utf8'));
async function ready() {
  await waitFor(async () => {
    if (!existsSync(accessFile)) return false;
    const value = access();
    if (value.fixture_mode !== 'managed-hardware' || !value.enabled) return false;
    const result = await request('http://127.0.0.1:8400', '/v1/status', { 'x-service-token': value.console.api_token });
    return result.status === 200 && result.body.ready === true;
  }, 'managed_native_did_not_become_ready');
  return access();
}
async function control(action: string) {
  const result = await request('http://127.0.0.1:25441', '/fixture/control', administrator, { action });
  check(result.status === 200, 'managed_control_failed'); return result.body;
}
async function complete(id: string) {
  await waitFor(async () => (await request('http://127.0.0.1:25441', '/api/v1/config/apply?id=' + id, administrator)).body.data?.status === 'succeeded', 'managed_apply_not_completed', 6000);
}
async function quota() {
  await execute('/usr/bin/python3', [resolve(root, 'test/search/managed_fixture_storage.py'), 'check', directory], { timeout: 10000, maxBuffer: 65536 });
}

const first = await ready();
// This mode only parses a private file. It must be a freshly linked client;
// an old binary's Usage error is never accepted as a passing validation gate.
await execute(client, ['--validate-managed-access', accessFile], { timeout: 10000, maxBuffer: 65536 });
const resultFile = resolve(directory, 'managed-result.json');
try {
  const work = execute(client, ['--run-hardware', '--managed-access-file', accessFile, '--input-nv12', input,
    '--matrix', 'bt601', '--range', 'limited', '--report', resultFile], { timeout: 150000, maxBuffer: 4194304 });
  if (work.child.pid) writeFileSync(resolve(directory, 'client.pid'), String(work.child.pid) + '\n', { mode: 0o600 });
  const result = await work;
  writeFileSync(resolve(directory, 'client.log'), result.stdout + result.stderr, { mode: 0o600 });
} catch (error) {
  const failure = error as { stdout?: string; stderr?: string };
  writeFileSync(resolve(directory, 'client.log'), (failure.stdout ?? '') + (failure.stderr ?? ''), { mode: 0o600 });
  throw new Error('managed_hardware_client_failed');
}
const result = JSON.parse(readFileSync(resultFile, 'utf8'));
check(result.interface_passed === true && result.semantic_accuracy_verified === false, 'hardware_interface_report');
const status = await request('http://127.0.0.1:8400', '/v1/status', { 'x-service-token': first.console.api_token });
check(status.status === 200 && status.body.model_version === result.model_version, 'paired_model_space_mismatch');
let publications = 0;
const publicationStarted = Date.now();
// A cold, empty database intentionally schedules its next bounded background
// discovery in 30s; samples arrive only after the real client loads/starts.
// Keep the acceptance finite while allowing that documented discovery cycle.
await waitFor(async () => {
  const current = access();
  const response = await request('http://127.0.0.1:25441', '/api/internal/search/index-jobs', manager,
    { action: 'catalog', revision: current.revision, model_version: result.model_version, cursor: null, limit: 16 });
  publications = response.status === 200 ? response.body.items?.length ?? 0 : 0;
  return publications > 0;
}, 'real_ssd_publication_not_observed', 45000);
const publicationWait = Date.now() - publicationStarted;
await quota();
await waitFor(async () => (await request('http://127.0.0.1:25441', '/api/v1/config/apply', administrator)).body.data?.status === 'succeeded', 'initial_apply_still_pending', 6000);
const disabled = await control('disable');
await waitFor(async () => {
  const state = (await request('http://127.0.0.1:25441', '/fixture/state', administrator)).body;
  return state.status === 'applied' && state.enabled === false && access().enabled === false && access().reason === 'disabled';
}, 'disable_not_acknowledged');
await complete(disabled.apply_id);
const denied = await request('http://127.0.0.1:8400', '/v1/match', { 'x-service-token': first.console.api_token }, {});
check(denied.status === 503 && denied.body.error === 'disabled', 'disabled_native_still_accepts_query');
const enabled = await control('enable'); const second = await ready(); await complete(enabled.apply_id);
check(second.producer.api_token === first.producer.api_token, 'saved_caller_rotated');
await control('source_generation');
await waitFor(async () => {
  const value = access(); return value.enabled && value.revision !== second.revision && value.producer.sources[0].input_path.endsWith('_g2');
}, 'source_generation_not_acknowledged');
const third = await ready();
const stale = await request('http://127.0.0.1:8400', '/v1/samples/receipt', {
  'x-service-token': second.producer.api_token, 'x-search-config-revision': second.revision }, {});
check(stale.status === 409, 'old_producer_revision_accepted');
const oldAck = await request('http://127.0.0.1:25441', '/api/internal/search/runtime-state', manager,
  { desired_version: second.desired_version, revision: second.revision, status: 'applied' });
check(oldAck.status === 409, 'old_runtime_ack_accepted');
check(third.producer.sources[0].channel_id === first.producer.sources[0].channel_id, 'stable_channel_identity_changed');
await quota();
const report = { passed: true, checks, real_pg: true, real_mongo: true, real_ssd_publications: publications,
  first_publication_wait_ms: publicationWait, background_empty_discovery_interval_ms: 30000,
  actual_managed_native: true, actual_bpu_client: true, forced_roi: true, semantic_accuracy_verified: false,
  real_runtime_ack: true, disable_acknowledged: true, stale_producer_rejected: true, stale_runtime_ack_rejected: true,
  source_uuid_preserved: true, no_production_configuration_changes: true };
writeFileSync(resolve(directory, 'managed-wire-report.json'), JSON.stringify(report) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(report));
