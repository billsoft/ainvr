import {createHash} from 'node:crypto';
import {BSON} from 'mongodb';

export const CHECKPOINT_MAX_ENTRIES = 12;
export const CHECKPOINT_MAX_BYTES = 1024 ** 2;
const canonical = value => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const checkpointHash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const bounded = value => value.entries.length <= CHECKPOINT_MAX_ENTRIES &&
  Buffer.byteLength(JSON.stringify(value)) <= CHECKPOINT_MAX_BYTES &&
  BSON.calculateObjectSize(value) <= CHECKPOINT_MAX_BYTES;

// Only an operator policy supplies an independently known package identity.
// Qualification without that identity never reuses inference results.
export class ReviewCheckpoint {
  constructor({rows, row, fence, authorization, binding, currentAuthorization, invoke}) {
    Object.assign(this, {rows, row, fence, authorization, currentAuthorization, invoke});
    this.enabled = /^[a-f0-9]{64}$/.test(authorization?.id ?? '') &&
      /^[a-f0-9]{64}$/.test(authorization?.model_sha256 ?? '');
    this.binding = checkpointHash({binding, authorization: authorization ?? null});
    this.cache = {version: 1, binding: this.binding, entries: []};
    this.anchored = false;
  }

  async active() {
    if (!await this.rows.findOne(this.fence, {projection: {alarm_id: 1}})) throw Error('review_fence_changed');
    const current = await this.currentAuthorization();
    if (checkpointHash(current ?? null) !== checkpointHash(this.authorization ?? null)) throw Error('authorization_changed');
  }

  async initialize() {
    const old = this.row.review.checkpoint;
    if (!this.enabled && old === undefined) return;
    if (this.enabled && old?.version === 1 && old.binding === this.binding &&
        Array.isArray(old.entries) && bounded(old)) {
      this.cache = structuredClone(old);
    }
    // Replace stale generations/policies/models; do not accumulate obsolete runs.
    const update = this.enabled ? {$set: {'review.checkpoint': this.cache}} : {$unset: {'review.checkpoint': ''}};
    const write = await this.rows.updateOne(this.fence, update);
    if (!write.matchedCount) throw Error('review_fence_changed');
    if (this.enabled) this.row.review.checkpoint = this.cache;
    else delete this.row.review.checkpoint;
  }

  matches(result, stage) {
    return result?.model?.package_sha256 === this.authorization?.model_sha256 &&
      result?.template === this.authorization?.prompt_template &&
      (stage === 'non_target' || result?.prepared_image?.layout === this.authorization?.layout);
  }

  async run(stage, frameId, request, validate) {
    // Includes cache hits and every primary call, not just secondary calls.
    await this.active();
    const {request_id: ignored, ...body} = request;
    const requestHash = checkpointHash(body);
    const key = checkpointHash({binding: this.binding, stage, frameId, requestHash});
    // No model-status endpoint is available. A fresh first primary on EVERY
    // attempt must establish the loaded package before any checkpoint reuse.
    const entry = this.enabled && this.anchored && this.cache.entries.find(e => e.key === key);
    if (entry && entry.response_sha256 === checkpointHash(entry.response) &&
        this.matches(entry.response, stage)) {
      const result = structuredClone(entry.response);
      await validate(result);
      return result;
    }
    const result = await this.invoke({...body, request_id: key});
    await validate(result);
    if (this.enabled && !this.matches(result, stage)) {
      // A qualified result can be valid outside the operator policy, but that
      // policy then supplies no identity for reuse in this attempt.
      this.enabled = false;
      const write = await this.rows.updateOne(this.fence, {$unset: {'review.checkpoint': ''}});
      if (!write.matchedCount) throw Error('review_fence_changed');
      delete this.row.review.checkpoint;
    }
    if (stage === 'primary' && this.enabled) this.anchored = true;
    // Keep the exact response, including both prepared/context JPEGs. Persistence
    // precedes image saving so a storage retry can replay the same audit images.
    const current = await this.currentAuthorization();
    if (this.enabled && checkpointHash(current ?? null) === checkpointHash(this.authorization) &&
        result.model?.package_sha256 === this.authorization.model_sha256) {
      const response = structuredClone(result);
      const next = {...this.cache, entries: this.cache.entries.filter(e => e.stage !== stage || e.frame_id !== frameId)};
      next.entries.push({key, stage, frame_id: frameId, request_sha256: requestHash,
        response_sha256: checkpointHash(response), response});
      // Capacity limits reuse only. Never turn a valid visual review into a
      // manual-only verdict merely because its audit JPEG is large.
      while (next.entries.length && !bounded(next)) next.entries.shift();
      const write = await this.rows.updateOne(this.fence, {$set: {'review.checkpoint': next}});
      if (!write.matchedCount) throw Error('review_fence_changed');
      this.cache = next;
      this.row.review.checkpoint = next;
    }
    return result;
  }
}
