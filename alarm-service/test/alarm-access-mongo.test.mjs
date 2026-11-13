import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {MongoClient} from 'mongodb';
import {AlarmRepository} from '../src/repository.mjs';
import {createApp} from '../src/http.mjs';
import {alarmRepositoryFor} from '../src/alarm-access.mjs';
import {memoryRepository, range} from './alarm-access-memory.mjs';

// Main agent owns this isolated Mongo instance. Never honor a production URI,
// start Docker, or reuse an existing database. Disabled by default.
const enabled = process.env.AINVR_ALARM_ACCESS_TEST_MONGO === '1';
test('Mongo permission filters agree across pagination, facets, serializers and mutation CAS', {skip: !enabled, timeout: 45000}, async t => {
  const client = new MongoClient('mongodb://127.0.0.1:27932/?directConnection=true', {serverSelectionTimeoutMS: 3000});
  const name = 'ainvr_alarm_access_test_' + randomUUID().replaceAll('-', '');
  assert.match(name, /^ainvr_alarm_access_test_[a-f0-9]{32}$/);
  const originalOpen = fs.open;
  fs.open = async (path, ...args) => {
    if (path === '/etc/ainvr/review-authorization.json') throw Error('No deployment configuration in isolated tests');
    return originalOpen(path, ...args);
  };
  syncBuiltinESMExports();
  let db, app;
  t.after(async () => {
    try { await app?.close(); if (db) await db.dropDatabase(); }
    finally { await client.close(); fs.open = originalOpen; syncBuiltinESMExports(); }
  });
  await client.connect(); db = client.db(name);
  const repository = new AlarmRepository(db, {clock: () => range.to});
  await repository.initialize();
  const fixture = memoryRepository();
  const rows = structuredClone(fixture.events.rows);
  for (const row of rows) { row.rule.snapshot.zone_id = 'z'; row.dedup_key = row.alarm_id; }
  await repository.events.insertMany(rows);
  await repository.behaviors.collection.insertMany(structuredClone(fixture.facts.rows));
  await repository.ruleSnapshots.collection.insertOne({_id: 'active', rules: [
    {id: 'ordinary-rule', name: 'Ordinary', event_kind: 'spatial', channel_id: 'ai-face', zone_id: 'z', behavior: 'appearance'},
    {id: 'face-rule', name: 'SECRET FACE RULE', event_kind: 'face_watchlist', channel_id: 'ai-face', zone_id: 'z', behavior: 'appearance'},
  ]});
  const token = 'isolated-mongo-permission-token-'.repeat(2);
  app = createApp({repository, apiToken: token});
  const headers = actor => ({authorization: `Bearer ${token}`, 'x-ainvr-actor': actor, 'idempotency-key': 'mongo-permission-op'});
  const local = headers('console-local'), admin = headers('console-administrator');
  const analytics = {...range, timezone: 'UTC', bucket: 'day'};
  assert.equal((await app.inject('/v1/events')).statusCode, 401);

  for (const [auth, count] of [[local, 2], [admin, 4]]) {
    const ids = []; let cursor;
    do {
      const page = await app.inject({url: '/v1/events?status=all&limit=1' + (cursor ? '&cursor=' + cursor : ''), headers: auth});
      assert.equal(page.statusCode, 200, page.body);
      ids.push(...page.json().items.map(row => row.alarm_id)); cursor = page.json().next_cursor;
      assert.ok(ids.length <= 4, 'pagination must terminate');
    } while (cursor);
    assert.equal(ids.length, count); assert.equal(new Set(ids).size, count);
    const summary = await app.inject({url: '/v1/events/summary', headers: auth});
    assert.equal(summary.statusCode, 200, summary.body);
    assert.equal(summary.json().pending, count);
    assert.equal(Object.values(summary.json().reference.counts).reduce((a, b) => a + b, 0), count);
    const stats = await app.inject({method: 'POST', url: '/v1/events/statistics', headers: auth,
      payload: {...range, locations: [{channel_id: 'ai-face', zone_id: 'z'}]}});
    assert.equal(stats.statusCode, 200, stats.body); assert.equal(stats.json().total, count);
    const aggregated = await app.inject({method: 'POST', url: '/v1/events/analytics', headers: auth, payload: analytics});
    assert.equal(aggregated.statusCode, 200, aggregated.body); assert.equal(aggregated.json().total, count);
    assert.equal(aggregated.body.includes('SECRET'), auth === admin);
    assert.equal(aggregated.json().catalog.event_kinds.includes('face_watchlist'), auth === admin);
    const drill = await app.inject({url: '/v1/events?status=all&analytics=' + encodeURIComponent(JSON.stringify(analytics)), headers: auth});
    assert.equal(drill.statusCode, 200, drill.body); assert.equal(drill.json().items.length, count);
    const behavior = await app.inject({url: '/v1/behavior-events?' + new URLSearchParams(range), headers: auth});
    assert.equal(behavior.statusCode, 200, behavior.body); assert.equal(behavior.json().items.length, count);
    const behaviorStats = await app.inject({url: '/v1/behavior-statistics?' + new URLSearchParams(range), headers: auth});
    assert.equal(behaviorStats.statusCode, 200, behaviorStats.body);
    assert.equal(behaviorStats.json().items.reduce((sum, row) => sum + row.occurrences, 0), count);
  }
  const explicitFace = await app.inject({method: 'POST', url: '/v1/events/analytics', headers: local, payload: {...analytics, event_kind: 'face_watchlist'}});
  assert.equal(explicitFace.statusCode, 200, explicitFace.body); assert.equal(explicitFace.json().total, 0);
  assert.equal(explicitFace.body.includes('SECRET'), false);
  const faceId = fixture.face.alarm_id;
  for (const path of [`/v1/events/${faceId}`, `/v1/events/${faceId}/logs`, `/v1/behavior-events/${faceId}`]) {
    assert.equal((await app.inject({url: path, headers: local})).statusCode, 404);
    assert.equal((await app.inject({url: path, headers: admin})).statusCode, 200);
  }
  const before = await repository.events.findOne({alarm_id: faceId});
  const bulk = await app.inject({method: 'POST', url: '/v1/bulk-acknowledgements', headers: local,
    payload: {items: [{alarm_id: 'ordinary-1', expected_handling_revision: 0}, {alarm_id: faceId, expected_handling_revision: 0}]}});
  assert.equal(bulk.statusCode, 200, bulk.body);
  assert.deepEqual(bulk.json().items.map(row => row.outcome), ['succeeded', 'not_found']);
  assert.deepEqual(await repository.events.findOne({alarm_id: faceId}), before);
  assert.equal((await app.inject({method: 'POST', url: `/v1/events/${faceId}/acknowledgements`, headers: admin, payload: {expected_handling_revision: 0}})).statusCode, 200);
  assert.equal((await app.inject({method: 'POST', url: `/v1/events/${faceId}/acknowledgements`, headers: local, payload: {expected_handling_revision: 0, event_kind: 'spatial'}})).statusCode, 404);
  assert.equal((await app.inject({method: 'POST', url: '/v1/events/purge', headers: local, payload: {scope: 'all'}})).statusCode, 403);

  // Each legacy marker independently hides an otherwise ordinary record.
  const markers = [{identity_kind: 'face'}, {incident_scope: 'face'},
    {analysis_evidence: {face: {member_name: 'SECRET'}}},
    {rule: {id: 'legacy-rule', snapshot: {event_kind: 'face_watchlist', member_name: 'SECRET'}}},
    {evidence: {refs: [{kind: 'face_record', record_id: 'SECRET'}]}},
    {evidence_refs: [{kind: 'face_record', record_id: 'SECRET'}]}];
  for (const [index, marker] of markers.entries()) {
    const id = 'marker-' + index;
    await repository.events.insertOne({...structuredClone(fixture.events.rows[0]), ...marker, alarm_id: id, dedup_key: id});
    assert.equal((await app.inject({url: '/v1/events/' + id, headers: local})).statusCode, 404);
    assert.equal((await app.inject({url: '/v1/events/' + id, headers: admin})).statusCode, 200);
  }
  const update = repository.events.updateOne.bind(repository.events);
  repository.events.updateOne = async (filter, change, options) => {
    await update({alarm_id: 'ordinary-2'}, {$set: {identity_kind: 'face'}});
    return update(filter, change, options);
  };
  try {
    await assert.rejects(alarmRepositoryFor(repository, 'console-local').confirm('ordinary-2', {expected_handling_revision: 0}, 'console-local', 'race'), error => error.code === 'not_found');
    assert.equal((await repository.events.findOne({alarm_id: 'ordinary-2'})).handling.state, 'unacknowledged');
  } finally { repository.events.updateOne = update; }
});
