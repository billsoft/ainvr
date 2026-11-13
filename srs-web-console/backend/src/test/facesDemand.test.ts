import { expect, it, vi } from 'vitest';
import { FacesDemand } from '../services/facesDemand.js';
import type { FacesExtractorStatus } from '../services/facesNativeClient.js';
import type { FacesLibrary } from '../services/facesContract.js';
const state = (enabled = false): FacesExtractorStatus => ({ schema: 'ainvr.face-runtime.v1', ready: false, can_extract: false, embedding_model: null, model_space_hash: null, detector_sha256: null, reason: 'budget_pending', accuracy_verified: false,
  configuration_revision: 3, apply_pending: true, persisted: true, configuration: { enabled, detector_model: 'face-det-scrfd-500m', embedding_model: 'face-embed-mbf', revision: 3 } });
const library = (model: 'mbf' | 'r50') => ({ document: { model, valid_until: new Date(Date.now() + 86400000).toISOString(), channel_ids: ['authorized-channel'] } } as FacesLibrary);
it('capture-only derives MBF without requiring a library, and pending persisted selection does not churn CAS', async () => {
  let current = state();
  const configure = vi.fn(async input => { current = { ...state(true), configuration: { ...input, revision: 4 } }; return current; });
  const demand = new FacesDemand({ status: async () => current, configure }, async () => [], async () => true, async () => false);
  expect((await demand.status()).can_extract).toBe(false);
  expect(configure).toHaveBeenCalledWith({ enabled: true, detector_model: 'face-det-scrfd-500m', embedding_model: 'face-embed-mbf', expected_revision: 3 });
  demand.invalidate(); await demand.status(); expect(configure).toHaveBeenCalledTimes(1);
});
it('library model drives one global choice; conflicting libraries never switch per request', async () => {
  let libraries = [library('r50')]; const configure = vi.fn(async () => state(true));
  const demand = new FacesDemand({ status: async () => state(), configure }, async () => libraries, async () => false, async () => false);
  await demand.status(); expect(configure).toHaveBeenCalledWith(expect.objectContaining({ embedding_model: 'face-embed-r50' }));
  libraries = [library('r50'), library('mbf')]; demand.invalidate();
  expect(await demand.status()).toMatchObject({ can_extract: false, reason: 'faces_model_conflict' }); expect(configure).toHaveBeenCalledTimes(1);
});
it('configuration read failure never disables the current hardware selection', async () => {
  const configure = vi.fn();
  const demand = new FacesDemand({ status: async () => state(true), configure }, async () => { throw Error('PG offline'); }, async () => false, async () => false);
  await expect(demand.status()).rejects.toThrow('PG offline'); expect(configure).not.toHaveBeenCalled();
});
