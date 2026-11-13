import type { FacesLibrary } from './facesContract.js';
import { FacesError } from './facesContract.js';
import type { FacesNativeClient, FacesExtractorStatus } from './facesNativeClient.js';

/** One persisted model selection for the device. Requests never select hardware.
 * Active library configuration drives the choice; capture-only defaults to MBF.
 * Existing historical evidence keeps the current space available for search.
 */
export class FacesDemand {
  private pending: Promise<FacesExtractorStatus> | null = null;
  private last: FacesExtractorStatus | null = null;
  private until = 0;
  constructor(private readonly native: Pick<FacesNativeClient, 'status' | 'configure'>,
    private readonly libraries: () => Promise<FacesLibrary[]>,
    private readonly hasCaptureSource: () => Promise<boolean>,
    private readonly hasEvidence: () => Promise<boolean>) {}
  invalidate() { this.until = 0; }
  status(): Promise<FacesExtractorStatus> {
    if (this.pending) return this.pending;
    if (this.last && Date.now() < this.until) return Promise.resolve(this.last);
    this.pending = this.reconcile().then(status => { this.last = status; this.until = Date.now() + 3000; return status; }).finally(() => { this.pending = null; });
    return this.pending;
  }
  private async reconcile(): Promise<FacesExtractorStatus> {
    // Read failures must not be interpreted as removal of all configuration.
    const libraries = (await this.libraries()).filter(library => Date.parse(library.document.valid_until) > Date.now() && library.document.channel_ids.length > 0);
    const current = await this.native.status(), models = new Set(libraries.map(library => library.document.model));
    if (models.size > 1) return { ...current, can_extract: false, reason: 'faces_model_conflict' };
    if (!current.configuration) throw new FacesError('faces_configuration_unavailable', '设备模型配置状态尚未就绪', 503);
    const hasSource = await this.hasCaptureSource(), hasEvidence = await this.hasEvidence();
    const model = [...models][0];
    const embedding = model ? (model === 'mbf' ? 'face-embed-mbf' : 'face-embed-r50') : hasEvidence ? current.configuration.embedding_model : 'face-embed-mbf';
    const enabled = hasSource || hasEvidence || libraries.length > 0;
    const desired = current.configuration;
    if (desired.enabled === enabled && desired.embedding_model === embedding) return current;
    // Preserve the chosen detector; default native configuration is SCRFD500m.
    // HTTP200 can still mean persisted/apply_pending. Never invent ready here.
    return this.native.configure({ enabled, detector_model: desired.detector_model, embedding_model: embedding, expected_revision: desired.revision });
  }
}
