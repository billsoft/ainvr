import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {AlarmRepository} from '../src/repository.mjs';

// Real-Mongo counterpart of review-checkpoint-privacy.test.mjs: the dotted
// exclusion projections must behave on a real server, not only in an emulator.
const uri = process.env.AINVR_REVIEW_TEST_MONGO_URI;
const now = '2026-10-31T12:00:00.000Z';
const SECRETS = /SECRET-LEASE-TOKEN|SECRET-JPEG-BASE64/;

test('real Mongo: get, plain list and analytics list never return the review checkpoint or lease token', {skip: !uri, timeout: 20000}, async () => {
  const client = new MongoClient(uri, {serverSelectionTimeoutMS: 3000});
  await client.connect();
  const db = client.db('ainvr_review_privacy_' + randomUUID().replaceAll('-', '').slice(0, 12));
  try {
    await db.collection('alarms').insertOne({
      alarm_id: 'probe-1', dedup_key: 'probe-1', channel_id: 'ch1', behavior: 'intrusion',
      occurred_at: now, last_seen_at: now, ingested_at: now, version: 1, stages: [], rules: [],
      handling: {state: 'unacknowledged', revision: 0, disposition: 'unset'},
      operations: [{key: 'k', fingerprint: 'f', response: {}}],
      logs: [{operation_id: 'created:probe-1', action: 'created', at: now}],
      rule: {id: 'r1', version: 1, snapshot: {zone_id: 'z1'}}, analysis_evidence: {track: {label_id: 'person'}},
      review: {state: 'running', generation: 1, token: 'SECRET-LEASE-TOKEN',
        checkpoint: {version: 1, binding: 'b', entries: [{response: {prepared_image: {jpeg_base64: 'SECRET-JPEG-BASE64'}}}]}},
    });
    const stored = await db.collection('alarms').findOne({alarm_id: 'probe-1'});
    assert.ok(stored.review.checkpoint && stored.review.token, 'control: the secrets really are stored');
    const repo = new AlarmRepository(db, {clock: () => now});
    const analytics = JSON.stringify({from: '2026-10-31T00:00:00Z', to: '2026-11-01T00:00:00Z', timezone: 'UTC', bucket: 'hour'});
    const responses = {
      get: await repo.get('probe-1'),
      list: await repo.list({status: 'all', limit: 10}),
      analyticsList: await repo.list({status: 'all', limit: 10, analytics}),
    };
    const reviews = {get: responses.get.review, list: responses.list.items[0]?.review, analyticsList: responses.analyticsList.items[0]?.review};
    for (const [name, review] of Object.entries(reviews)) {
      assert.ok(review, `${name}: review is still returned`);
      assert.equal(review.state, 'running', name);
      assert.equal('checkpoint' in review, false, `${name}: checkpoint leaked`);
      assert.equal('token' in review, false, `${name}: token leaked`);
    }
    for (const [name, response] of Object.entries(responses)) assert.equal(SECRETS.test(JSON.stringify(response)), false, `${name}: secret in serialised response`);
  } finally {
    await db.dropDatabase();
    await client.close();
  }
});
