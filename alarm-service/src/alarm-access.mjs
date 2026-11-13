// Only a service-token-authenticated BFF may supply the console principal.
// Missing/unknown principals retain ordinary alarm access, never face access.
import {fail} from './domain.mjs';

export const canAccessFaces = principal => principal === 'console-administrator';
const kindPaths = ['event_kind', 'rule.event_kind', 'rule.snapshot.event_kind',
  'region_state.event_kind', 'stages.event_kind'];
const presencePaths = ['analysis_evidence.face', 'analysis_evidence.face_watchlist',
  'face_watchlist', 'rule.snapshot.face_watchlist'];
const markers = [
  ...kindPaths.map(path => [path, 'face_watchlist']),
  ['identity_kind', 'face'], ['incident_scope', 'face'],
  ['kind', 'face_watchlist_candidate'],
  ['analysis_evidence.observation_mode', 'face_candidate'],
  ['evidence.refs.kind', 'face_record'], ['evidence_refs.kind', 'face_record'],
];
export function ordinaryAlarmFilter(prefix = '') {
  return {$nor: [...markers.map(([path, value]) => ({[prefix + path]: value})),
    ...presencePaths.map(path => ({[prefix + path]: {$exists: true}}))]};
}
const valuesAt = (value, parts) => {
  if (!parts.length) return [value];
  if (Array.isArray(value)) return value.flatMap(item => valuesAt(item, parts));
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, parts[0])) return [];
  return valuesAt(value[parts[0]], parts.slice(1));
};
export function isFaceProtected(value) {
  return markers.some(([path, marker]) => valuesAt(value, path.split('.')).includes(marker)) ||
    presencePaths.some(path => valuesAt(value, path.split('.')).length > 0);
}
export function requireFaceAccess(principal) {
  if (!canAccessFaces(principal)) fail('faces_management_required', 'Authenticated console administrator required', 403);
}

// Apply to the persisted document BEFORE projection, sorting, page limits or
// facets. The same predicate fences confirmation CAS writes and idempotency
// replays. No client filter, event_kind claim or response-page filtering grants
// access. This facade deliberately exposes only the operations these APIs use.
export function ordinaryAlarmCollection(collection, prefix = '') {
  const match = query => ({$and: [ordinaryAlarmFilter(prefix), query ?? {}]});
  return {
    find: (query, options) => collection.find(match(query), options),
    findOne: (query, options) => collection.findOne(match(query), options),
    countDocuments: (query, options) => collection.countDocuments(match(query), options),
    aggregate: (pipeline, options) => collection.aggregate([{$match: ordinaryAlarmFilter(prefix)}, ...pipeline], options),
    updateOne: (query, update, options) => collection.updateOne(match(query), update, options),
    deleteMany: (query, options) => collection.deleteMany(match(query), options),
  };
}

// Per-request views never mutate the repository shared by workers/admins.
export function alarmRepositoryFor(repository, principal) {
  if (canAccessFaces(principal)) return repository;
  const view = Object.create(repository);
  view.faceAccess = false;
  if (repository.events) view.events = ordinaryAlarmCollection(repository.events);
  if (repository.rules) view.rules = ordinaryAlarmCollection(repository.rules);
  if (repository.behaviors) {
    view.behaviors = Object.create(repository.behaviors);
    view.behaviors.collection = ordinaryAlarmCollection(repository.behaviors.collection);
  }
  // Vehicle detail/correction routes also address behavior facts by ID. Bind
  // their repository and persisted job-event scope to this request, too.
  if (repository.vehicles) {
    view.vehicles = Object.create(repository.vehicles);
    view.vehicles.repository = view;
    if (repository.vehicles.jobs) view.vehicles.jobs = ordinaryAlarmCollection(repository.vehicles.jobs, 'event.');
  }
  // Counting detail/export also reads behavior_events. Counter filters are a
  // business scope, not a substitute for permission on mixed/legacy facts.
  if (repository.flow) {
    view.flow = Object.create(repository.flow);
    // The shared clear ledger must retain the same permission boundary as facts.
    view.flow.faceAccess = false;
    if (repository.flow.facts) view.flow.facts = ordinaryAlarmCollection(repository.flow.facts);
  }
  // clearAll also writes global tombstones; filtering deleteMany alone would
  // still delete/prevent replay of face records. It is administrator-only.
  view.clearAll = () => requireFaceAccess(principal);
  return view;
}
