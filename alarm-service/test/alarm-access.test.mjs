import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {createApp} from '../src/http.mjs';
import {alarmRepositoryFor, ordinaryAlarmFilter} from '../src/alarm-access.mjs';
import {memoryRepository, matches, range} from './alarm-access-memory.mjs';

const token = 'permission-route-test-only-'.repeat(3);
// pendingSummary reads this deployment grant; never inspect live configuration.
const originalOpen = fs.open;
fs.open = async (path, ...args) => {
  if (path === '/etc/ainvr/review-authorization.json') throw Error('No deployment grant in memory tests');
  return originalOpen(path, ...args);
};
syncBuiltinESMExports();
test.after(() => { fs.open = originalOpen; syncBuiltinESMExports(); });
const headers = (actor = 'console-local') => ({authorization: `Bearer ${token}`,
  'x-ainvr-actor': actor, 'idempotency-key': 'permission-test'});
const query = new URLSearchParams(range).toString();
async function setup(t) {
  const fixture = memoryRepository();
  const app = createApp({repository: fixture.repository, apiToken: token});
  t.after(() => app.close());
  return {...fixture, app};
}
test('real routes/serializers filter before pagination; legacy markers and client kinds cannot grant face access', async t => {
  const {app, face} = await setup(t);
  const first = await app.inject({url: '/v1/events?status=all&limit=1', headers: headers()});
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json().items.map(x => x.alarm_id), ['ordinary-1']);
  assert.ok(first.json().next_cursor);
  const second = await app.inject({url: '/v1/events?status=all&limit=1&cursor=' + first.json().next_cursor, headers: headers()});
  assert.deepEqual(second.json().items.map(x => x.alarm_id), ['ordinary-2']);
  assert.equal(second.json().next_cursor, null);
  assert.equal(first.body.includes('SECRET'), false);
  for (const path of ['', '/logs']) {
    for (const id of [face.alarm_id, 'legacy-face']) {
      const hidden = await app.inject({url: `/v1/events/${id}${path}`, headers: headers()});
      assert.equal(hidden.statusCode, 404, hidden.body);
      assert.equal(hidden.body.includes('SECRET'), false);
    }
    const admin = await app.inject({url: `/v1/events/${face.alarm_id}${path}`, headers: headers('console-administrator')});
    assert.equal(admin.statusCode, 200, admin.body);
    assert.ok(admin.body.includes('SECRET FACE NAME'));
  }
  const forced = await app.inject({url: '/v1/events?status=all&event_kind=face_watchlist', headers: headers()});
  assert.deepEqual(forced.json().items, []);
  const adminPage = await app.inject({url: '/v1/events?status=all&limit=1', headers: headers('console-administrator')});
  assert.equal((await app.inject({url: '/v1/events?status=all&limit=1&cursor=' + adminPage.json().next_cursor, headers: headers()})).statusCode, 422);
  assert.equal((await app.inject({url: '/v1/events', headers: {'x-ainvr-actor': 'console-administrator'}})).statusCode, 401);
  const legacyCaller = await app.inject({url: '/v1/events?status=all', headers: {authorization: `Bearer ${token}`}});
  assert.equal(legacyCaller.json().items.length, 2);
});

test('summary, statistics, analytics/CSV source and rule catalog share query-level permissions', async t => {
  const {app, events} = await setup(t);
  for (const [actor, count] of [['console-local', 2], ['console-administrator', 4]]) {
    const summary = await app.inject({url: '/v1/events/summary', headers: headers(actor)});
    assert.equal(summary.statusCode, 200, summary.body);
    assert.equal(summary.json().pending, count);
    const stats = await app.inject({method: 'POST', url: '/v1/events/statistics', headers: headers(actor),
      payload: {...range, locations: [{channel_id: 'ai-face', zone_id: 'z'}]}});
    assert.equal(stats.statusCode, 200, stats.body);
    assert.equal(stats.json().total, count);
    const analytics = await app.inject({method: 'POST', url: '/v1/events/analytics', headers: headers(actor),
      payload: {...range, timezone: 'UTC', bucket: 'day'}});
    assert.equal(analytics.statusCode, 200, analytics.body);
    assert.equal(analytics.json().total, count);
    assert.equal(analytics.body.includes('SECRET'), actor === 'console-administrator');
    const rules = await app.inject({url: '/v1/rules', headers: headers(actor)});
    assert.equal(rules.json().items.length, actor === 'console-local' ? 1 : 2);
    if (actor === 'console-local') for (const pipeline of events.pipelines) assert.deepEqual(pipeline[0], {$match: ordinaryAlarmFilter()});
    events.pipelines.length = 0;
  }
});

test('behavior history, statistics and evidence sources enforce persisted identity', async t => {
  const {app, face} = await setup(t);
  const first = await app.inject({url: '/v1/behavior-events?' + query + '&limit=1', headers: headers()});
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json().items.map(x => x.event_id), ['ordinary-1']);
  const second = await app.inject({url: '/v1/behavior-events?' + query + '&limit=1&cursor=' + first.json().next_cursor, headers: headers()});
  assert.deepEqual(second.json().items.map(x => x.event_id), ['ordinary-2']);
  assert.equal(second.json().next_cursor, null);
  const stats = await app.inject({url: '/v1/behavior-statistics?' + query, headers: headers()});
  assert.equal(stats.statusCode, 200, stats.body);
  assert.equal(stats.json().items[0].occurrences, 2);
  for (const suffix of ['', '/evidence', '/evidence/image']) {
    assert.equal((await app.inject({url: `/v1/behavior-events/${face.alarm_id}${suffix}`, headers: headers()})).statusCode, 404);
    assert.equal((await app.inject({url: `/v1/behavior-events/${face.alarm_id}${suffix}`, headers: headers('console-administrator')})).statusCode, 200);
    assert.equal((await app.inject({url: `/v1/behavior-events/ordinary-1${suffix}`, headers: headers()})).statusCode, 200);
  }
  assert.equal((await app.inject({url: `/v1/alarms/${face.alarm_id}/review-frames/key`, headers: headers()})).statusCode, 404);
  assert.equal((await app.inject({url: `/v1/alarms/${face.alarm_id}/review-frames/key`, headers: headers('console-administrator')})).statusCode, 200);
  assert.equal((await app.inject({url: '/v1/alarms/ordinary-1/review-frames/key', headers: headers()})).statusCode, 200);
});

test('single, bulk, idempotency replay and CAS never modify a protected candidate', async t => {
  const {app, face, events} = await setup(t);
  const original = structuredClone(events.rows.find(x => x.alarm_id === face.alarm_id));
  const one = await app.inject({method: 'POST', url: `/v1/events/${face.alarm_id}/acknowledgements`, headers: headers(), payload: {expected_handling_revision: 0}});
  assert.equal(one.statusCode, 404);
  const bulk = await app.inject({method: 'POST', url: '/v1/bulk-acknowledgements', headers: headers(), payload: {items: [
    {alarm_id: 'ordinary-1', expected_handling_revision: 0}, {alarm_id: face.alarm_id, expected_handling_revision: 0}, {alarm_id: 'legacy-face', expected_handling_revision: 0}]}});
  assert.equal(bulk.statusCode, 200, bulk.body);
  assert.deepEqual(bulk.json().items.map(x => x.outcome), ['succeeded', 'not_found', 'not_found']);
  assert.deepEqual(events.rows.find(x => x.alarm_id === face.alarm_id), original);
  for (const write of events.writes) assert.deepEqual(write.$and[0], ordinaryAlarmFilter());
  const admin = await app.inject({method: 'POST', url: `/v1/events/${face.alarm_id}/acknowledgements`, headers: headers('console-administrator'), payload: {expected_handling_revision: 0}});
  assert.equal(admin.statusCode, 200, admin.body);
  const replay = await app.inject({method: 'POST', url: `/v1/events/${face.alarm_id}/acknowledgements`, headers: headers(), payload: {expected_handling_revision: 0}});
  assert.equal(replay.statusCode, 404);
  assert.equal((await app.inject({method: 'POST', url: '/v1/events/purge', headers: headers(), payload: {scope: 'all'}})).statusCode, 403);
});

test('scoped collection CAS remains fenced if a row changes classification after the read', async () => {
  const {repository, events} = memoryRepository();
  const update = events.updateOne.bind(events);
  events.updateOne = async (query, change) => {
    events.rows.find(x => x.alarm_id === 'ordinary-1').identity_kind = 'face';
    return update(query, change);
  };
  await assert.rejects(alarmRepositoryFor(repository, 'console-local').confirm('ordinary-1', {expected_handling_revision: 0}, 'console-local', 'race'), e => e.code === 'not_found');
  assert.equal(events.rows.find(x => x.alarm_id === 'ordinary-1').handling.state, 'unacknowledged');
  assert.ok(matches({analysis_evidence: {vehicle: {reason: 'watchlist_match'}}}, ordinaryAlarmFilter()));
  assert.equal(repository.faceAccess, undefined);
});

test('vehicle ID aliases and counting detail/export cannot bypass behavior permissions', async t => {
  const {app, repository, facts, face} = await setup(t);
  let calls = 0;
  repository.vehicles = Object.fromEntries(['details', 'image', 'retry', 'correct'].map(name => [name, async () => { calls++; return name === 'image' ? Buffer.from('test-image') : {ok: true}; }]));
  for (const [method, suffix] of [['GET', ''], ['GET', '/images/key'], ['POST', '/retry'], ['PUT', '/correction']]) {
    const denied = await app.inject({method, url: `/v1/vehicles/${face.alarm_id}${suffix}`, headers: headers(), ...(method === 'GET' ? {} : {payload: {text: 'ABC123', version: 0}})});
    assert.equal(denied.statusCode, 404, denied.body);
    assert.equal(calls, 0);
  }
  assert.equal((await app.inject({url: '/v1/vehicles/ordinary-1', headers: headers()})).statusCode, 200);
  assert.equal((await app.inject({url: `/v1/vehicles/${face.alarm_id}`, headers: headers('console-administrator')})).statusCode, 200);
  repository.flow.query = async function () { return {items: await this.facts.find({}).toArray()}; };
  const countExport = await app.inject({method: 'POST', url: '/v1/flow/query', headers: headers(), payload: {}});
  assert.equal(countExport.statusCode, 200, countExport.body);
  assert.equal(countExport.json().items.length, 2);
  assert.equal(countExport.body.includes('SECRET'), false);
  const local = alarmRepositoryFor(repository, 'console-local');
  assert.equal((await local.flow.facts.deleteMany({})).deletedCount, 2);
  assert.equal(facts.rows.length, 2);
  assert.ok(facts.rows.every(row => row.identity_kind === 'face'));
  assert.equal(matches({event: face}, ordinaryAlarmFilter('event.')), false);
});
