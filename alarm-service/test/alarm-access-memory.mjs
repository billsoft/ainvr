// In-memory Mongo boundary for permission route tests. No sockets or database.
// Aggregation facets below emulate only the result shapes needed by these tests;
// Mongo expression correctness remains the separate real-DB suite's concern.
import assert from 'node:assert/strict';
import {AlarmRepository} from '../src/repository.mjs';
import {makeFaceWatchlistAlarm} from '../src/face-watchlist-candidate.mjs';
import {candidate} from './face-watchlist-fixture.mjs';

const at = (row, path) => {
  const walk = (value, parts) => !parts.length ? [value] : Array.isArray(value)
    ? value.flatMap(item => walk(item, parts)) : value && Object.hasOwn(value, parts[0])
      ? walk(value[parts[0]], parts.slice(1)) : [];
  return walk(row, path.split('.'));
};
export function matches(row, query) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === '$and') return expected.every(q => matches(row, q));
    if (key === '$or') return expected.some(q => matches(row, q));
    if (key === '$nor') return !expected.some(q => matches(row, q));
    const values = at(row, key);
    if (!expected || typeof expected !== 'object') return values.includes(expected);
    return Object.entries(expected).every(([op, value]) => {
      if (op === '$exists') return !!values.length === value;
      if (op === '$ne') return !values.includes(value);
      if (op === '$in') return values.some(v => value.includes(v));
      if (op === '$lte') return values.some(v => v <= value);
      if (op === '$lt') return values.some(v => v < value);
      if (op === '$gte') return values.some(v => v >= value);
      if (op === '$gt') return values.some(v => v > value);
      if (op === '$elemMatch') return values.some(v => Array.isArray(v) && v.some(x => matches(x, value)));
      if (op === '$type') return values.some(v => typeof v === value);
      throw Error('Unsupported test query operator: ' + op);
    });
  });
}
function project(row, projection = {}) {
  const copy = structuredClone(row);
  for (const [path, included] of Object.entries(projection)) if (!included) {
    const parts = path.split('.'); let target = copy;
    for (const part of parts.slice(0, -1)) target = target?.[part];
    if (target) delete target[parts.at(-1)];
  }
  return copy;
}
const groups = (rows, key) => [...Map.groupBy(rows, row => at(row, key)[0]).entries()];
export class MemoryCollection {
  constructor(rows = []) { this.rows = rows; this.queries = []; this.pipelines = []; this.writes = []; }
  find(query, options = {}) {
    this.queries.push(query);
    let selected = this.rows.filter(row => matches(row, query));
    const cursor = {
      sort(order) { selected.sort((a, b) => { for (const [key, direction] of Object.entries(order)) { if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * direction; } return 0; }); return cursor; },
      limit(n) { selected = selected.slice(0, n); return cursor; },
      toArray: async () => selected.map(row => project(row, options.projection)),
    };
    return cursor;
  }
  async findOne(query, options) { return (await this.find(query, options).limit(1).toArray())[0] ?? null; }
  async countDocuments(query) { return (await this.find(query).toArray()).length; }
  async deleteMany(query) { const before = this.rows.length; this.rows = this.rows.filter(row => !matches(row, query)); return {deletedCount: before - this.rows.length}; }
  async updateOne(query, update) {
    this.writes.push(query);
    const row = this.rows.find(row => matches(row, query));
    if (!row) return {modifiedCount: 0};
    Object.assign(row, update.$set);
    for (const [key, value] of Object.entries(update.$inc ?? {})) row[key] += value;
    for (const [key, value] of Object.entries(update.$push ?? {})) row[key].push(value);
    return {modifiedCount: 1};
  }
  aggregate(pipeline) {
    this.pipelines.push(pipeline);
    let rows = structuredClone(this.rows);
    for (const stage of pipeline) {
      if (stage.$match) rows = rows.filter(row => matches(row, stage.$match));
      else if (stage.$sort) { const order = stage.$sort; rows.sort((a, b) => { for (const [key, direction] of Object.entries(order)) if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * direction; return 0; }); }
      else if (stage.$limit) rows = rows.slice(0, stage.$limit);
      else if (stage.$project) rows = rows.map(row => project(row, stage.$project));
      else if (stage.$set) { /* Test fixtures already have the derived business kind/audit. */ }
      else if (stage.$group) rows = [{_id: 'waiting', count: rows.length}];
      else if (stage.$facet) {
        const n = rows.length;
        if (stage.$facet.summary) rows = [{capacity: [{total: n}], summary: [{_id: 'pending', total: n}],
          catalogKinds: groups(rows, 'event_kind').map(([kind]) => ({_id: kind})),
          historicalNames: rows.map(row => ({_id: {trigger_id: row.rule.id, channel_id: row.channel_id, zone_id: 'z'}, trigger_name: row.rule.name})),
          catalogTriggers: groups(rows, 'rule.id').map(([id]) => ({_id: id}))}];
        else if (stage.$facet.totals) rows = [{totals: groups(rows, 'event_type').map(([type, items]) => ({_id: {type}, occurrences: items.length, tracked_targets: items.length}))}];
        else if (stage.$facet.total) rows = [{total: [{count: n}], handling: [{_id: 'unacknowledged', count: n}], review: [], unassociated: []}];
        else assert.fail('Unexpected aggregation facet');
      } else assert.fail('Unexpected aggregation stage');
    }
    return {toArray: async () => rows};
  }
}
export const range = {from: '2026-11-12T00:00:00.000Z', to: '2026-11-13T00:00:00.000Z'};
export function memoryRepository() {
  const ordinary = (id, minute) => ({alarm_id: id, event_kind: 'spatial', channel_id: 'ai-face',
    occurred_at: `2026-11-12T12:${minute}:00.000Z`, ingested_at: range.from,
    behavior: 'appearance', rule: {id: 'ordinary-rule', name: 'Ordinary', snapshot: {zone_id: 'z'}},
    handling: {state: 'unacknowledged', revision: 0, disposition: 'unset'}, version: 1,
    review: {state: 'skipped'}, logs: [], operations: []});
  const face = {...makeFaceWatchlistAlarm(candidate()), ingested_at: range.from, operations: [], logs: [{note: 'SECRET FACE NAME'}]};
  face.rule.name = 'SECRET FACE NAME'; face.rule.snapshot.member_name = 'SECRET FACE NAME';
  face.analysis_evidence.face.member_name = 'SECRET FACE NAME';
  const legacy = {...structuredClone(face), alarm_id: 'legacy-face', event_kind: 'spatial'};
  const events = new MemoryCollection([ordinary('ordinary-1', '01'), face, legacy, ordinary('ordinary-2', '00')]);
  const facts = new MemoryCollection(events.rows.map(row => ({...structuredClone(row),
    event_id: row.alarm_id, event_type: 'appearance', evidence_refs: row.evidence?.refs ?? []})));
  const collections = new Map([['alarms', events], ['behavior_events', facts]]);
  const db = {collection(name) { if (!collections.has(name)) collections.set(name, new MemoryCollection()); return collections.get(name); }};
  const repository = new AlarmRepository(db, {clock: () => range.to});
  repository.ruleSnapshots.current = async () => ({rules: [{id: 'ordinary-rule', name: 'Ordinary'}, {id: 'face-rule', name: 'SECRET FACE NAME', event_kind: 'face_watchlist'}]});
  repository.reviewContext = {retained: async () => Buffer.from('test-image')};
  repository.evidenceVault = {metadata: async () => ({state: 'available'}), image: async () => Buffer.from('test-image')};
  return {repository, events, facts, face};
}
