// Destructive fresh-model cutover policy. No database or service side effects.
export const OLD_PACKAGE = 'siglip2-base-full-int8';
export const NEW_PACKAGE = 'siglip-so400m-i18n-full-int8';
const PACKAGE_DIMENSIONS = Object.freeze({[OLD_PACKAGE]:768,[NEW_PACKAGE]:1152});
// Both endpoints are explicit: a misspelled or same-model request must fail closed.
export function freshModelTransition(sourcePackage, targetPackage) {
  if (!Object.hasOwn(PACKAGE_DIMENSIONS,sourcePackage) ||
      !Object.hasOwn(PACKAGE_DIMENSIONS,targetPackage) || sourcePackage===targetPackage)
    throw Error('unsupported_fresh_model_transition');
  return Object.freeze({sourcePackage,targetPackage,
    sourceDimensions:PACKAGE_DIMENSIONS[sourcePackage],
    targetDimensions:PACKAGE_DIMENSIONS[targetPackage]});
}
export const SEARCH_COLLECTIONS = Object.freeze([
  'search_samples','search_coverage','search_deletions','search_sessions',
  'search_verification_cache','search_migration_reports','search_control',
]);
export function freshModelSettings(settings, pin, models, transition) {
  const {sourcePackage,targetPackage}=freshModelTransition(transition?.sourcePackage,transition?.targetPackage);
  if (!settings || settings.model?.package_id !== sourcePackage || pin?.package_id !== sourcePackage ||
      !/^search-v1-[a-f0-9]{64}$/.test(pin.model_version) ||
      models.some(model => model !== pin.model_version)) throw Error('fresh_switch_source_mismatch');
  const next = structuredClone(settings);
  next.model.package_id = targetPackage;
  // Returning to SigLIP2 changes only the model; retain all current user tuning.
  if (targetPackage === OLD_PACKAGE) return next;
  // Search sampling only; never changes detector FPS or tracking timing.
  next.sampling.object_interval_ms = Math.max(4000, next.sampling.object_interval_ms);
  next.sampling.scene_active_interval_ms = Math.max(20000, next.sampling.scene_active_interval_ms);
  next.sampling.scene_static_interval_ms = Math.max(60000, next.sampling.scene_static_interval_ms, next.sampling.scene_active_interval_ms);
  next.sampling.scene_change_min_interval_ms = Math.max(5000, next.sampling.scene_change_min_interval_ms);
  next.limits.producer_queue = 1;
  return next;
}
export function validateFreshModelManifest(manifest, pin, transition) {
  const {sourcePackage,sourceDimensions}=freshModelTransition(transition?.sourcePackage,transition?.targetPackage);
  if (pin?.package_id!==sourcePackage || !/^search-v1-[a-f0-9]{64}$/.test(pin?.model_version) ||
      manifest?.dimensions!==sourceDimensions || manifest.model_version!==pin.model_version)
    throw Error('mixed_index_space');
}
export function validateCollections(names) {
  if(names.some(name=>name.startsWith('search_')&&!SEARCH_COLLECTIONS.includes(name)))
    throw Error('unknown_search_collection_requires_review');
  return names.filter(name=>SEARCH_COLLECTIONS.includes(name));
}

// The child flock shares the parent's open file description (inherited fd 3).
// Keep that description open until every operation and recovery attempt ends.
export function acquireDeploymentLock({open, lock, close}) {
  const fd = open('/run/lock/ainvr-ptz-deploy.lock');
  try { lock(fd); }
  catch { close(fd); throw Error('deployment_lock_unavailable'); }
  let held = true;
  return () => { if (held) { held = false; close(fd); } };
}

export function recoverFreshModelServices(run) {
  const failures = [];
  for (const [action, unit] of [['stop','ainvr-ai'],['stop','ainvr-search'],['start','ainvr-backend']]) {
    try { run('systemctl', action, unit); }
    catch { failures.push(`${action}:${unit}`); }
  }
  return failures;
}

export async function waitForCondition(probe, {
  timeoutMs = 120000, intervalMs = 500,
  now = () => performance.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try { if (await probe(deadline - now())) return; } catch { /* Retry within the same bounded budget. */ }
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(intervalMs, remaining));
  }
  throw Error('fresh_model_readiness_timeout');
}

export function freshModelReady(runtime, status, ai, version, requireSampling, transition) {
  const {targetPackage}=freshModelTransition(transition?.sourcePackage,transition?.targetPackage);
  const pin = runtime?.active_model_pin;
  const sampling = ai?.business?.search_sampling;
  return runtime?.desired_version === version && pin?.package_id === targetPackage &&
    /^search-v1-[a-f0-9]{64}$/.test(pin?.model_version) &&
    status?.ready === true && status.model_version === pin.model_version &&
    ai?.status === 'ok' && ai.business?.ready === true &&
    (!requireSampling || sampling?.ready === true) &&
    (!sampling?.ready || sampling.model_version === pin.model_version);
}
