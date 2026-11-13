import { createHash, randomUUID } from 'node:crypto';
import { Binary, ObjectId, type Document } from 'mongodb';
import type { FacesMongo } from '../store/facesMongo.js';
import { FacesError } from './facesContract.js';
import { facesCaptureSchema, type FacesRuntime } from './facesRuntime.js';
import type { SearchAiProcessor } from './searchSourceCatalog.js';

export interface FacesCaptureSource { processor_id: string; channel_id: string; recording_channel_id: string; retention_days: number; capture_supported: boolean; reason: string | null; source_revision?: string; face_labels?: string[] }
export function facesSourceLabels(config: SearchAiProcessor['config']) {
  const face = (adapter?: string) => ['scrfd_bpu', 'yoloface_bpu', 'yoloface'].includes(adapter ?? '');
  return [...(face(config.model?.adapter) ? [config.analysis_pipeline?.root_id && config.analysis_pipeline.root_id !== 'primary' ? `node:${config.analysis_pipeline.root_id}:class:0` : 'class:0'] : []), ...(config.analysis_pipeline?.nodes ?? []).filter(node => face(node.model.adapter)).map(node => `node:${node.id}:class:0`)];
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = (value: unknown) => { const h = hash(value); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
/** Validate archive provenance, never substitute an enhanced or full-frame image. */
export function facesArchiveCapture(row: Document, source: FacesCaptureSource, model: 'mbf' | 'r50', now = Date.now()) {
  const origin = row.model_extra?.observation_source;
  if (row.task_type !== 'face_detection' || row.channel_id !== source.processor_id || !source.face_labels?.includes(row.label_id) || !row.bbox || row.bbox.w <= 0 || row.bbox.h <= 0 || !origin || origin.schema_version !== '1.0' || !(origin.frame_width > 0 && origin.frame_height > 0) || !row.track_id) return null;
  if (typeof row.frame_pts_ns === 'number' && !Number.isSafeInteger(row.frame_pts_ns)) return null;
  if (String(row.frame_pts_ns) !== origin.source_pts_ns || !Number.isFinite(row.timestamp)) return null;
  const at = row.timestamp * 1000;
  if (at > now + 5000 || at < now - source.retention_days * 86400000) return null;
  const photo = row.original_image;
  if (photo?.format !== 'jpg' || !(photo.width > 0 && photo.height > 0) || !(photo.data instanceof Binary)) return null;
  const bytes = Buffer.from(photo.data.buffer);
  if (bytes.length < 4 || bytes.length > 4 * 1024 * 1024 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return null;
  const parsed = facesCaptureSchema.safeParse({ request_id: uuid([source.channel_id, row.image_id]), model, jpeg_base64: bytes.toString('base64'), channel_id: source.channel_id, processor_id: source.processor_id,
    session_id: origin.stream_session_id, track_id: row.track_id, frame_id: `${origin.stream_session_id}:${origin.source_frame_index}`, source_pts_ns: origin.source_pts_ns, source_frame_index: origin.source_frame_index,
    captured_at: new Date(at).toISOString(), recording_channel_id: source.recording_channel_id });
  return parsed.success ? parsed.data : null;
}
/** One bounded poll, no video client. Checkpoints survive restart. Five-minute
 * replay handles late archive commits; coverage remains sampled, never complete.
 * A track has at most three quality attempts and stops after its first success.
 */
export class FacesArchiveProducer {
  private round = 0;
  private readonly owner = randomUUID();
  constructor(private readonly mongo: FacesMongo, private readonly runtime: Pick<FacesRuntime, 'capture' | 'status'>,
    private readonly sources: () => Promise<FacesCaptureSource[]>, private readonly authorized: () => boolean) {}
  async tick() {
    if (!this.authorized()) throw new FacesError('faces_capture_license_unavailable', '抓拍授权暂不可用', 503);
    const sources = (await this.sources()).filter(s => s.capture_supported && s.source_revision && s.face_labels?.length);
    if (!sources.length) return;
    const status = await this.runtime.status();
    if (!status.ready || !status.active_model) throw new FacesError('faces_extractor_pending', '等待人脸模型就绪', 503);
    const source = sources[this.round++ % sources.length]!;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(source.processor_id)) throw new FacesError('faces_archive_source_invalid', '抓拍来源标识不受支持', 503);
    const db = await this.mongo.db(), checkpoints = db.collection<Document & { _id: string }>('faces_archive_checkpoints');
    const tracks = db.collection<Document & { _id: string }>('faces_archive_tracks');
    await tracks.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
    const key = hash([source.processor_id, source.channel_id]);
    const now = new Date(), anchor = ObjectId.createFromTime(Math.floor(now.getTime() / 1000));
    let checkpoint: Document | null;
    try { checkpoint = await checkpoints.findOneAndUpdate({ _id: key, $or: [{ owner: this.owner }, { lease_until: { $lte: now } }] }, { $set: { owner: this.owner, lease_until: new Date(Date.now() + 120000) }, $setOnInsert: { revision: source.source_revision, highwater: anchor, replay: anchor, started_at: now } }, { upsert: true, returnDocument: 'after', writeConcern: { w: 1, j: true } }); }
    catch (error) { if ((error as { code?: number }).code === 11000) return; throw error; }
    if (!checkpoint) return;
    try {
      if (checkpoint.revision !== source.source_revision) {
        await checkpoints.updateOne({ _id: key, owner: this.owner }, { $set: { revision: source.source_revision, highwater: anchor, replay: anchor, started_at: now, coverage: 'sampled', reason: 'source_changed' } }); return;
      }
      const collection = db.collection(`snapshots_${source.processor_id}`);
      // Metadata first; at most one original JPEG is held at a time.
      for (const lane of ['highwater', 'replay'] as const) {
        const floor = ObjectId.createFromTime(Math.floor((Date.now() - 300000) / 1000));
        const cursor = lane === 'replay' && checkpoint[lane].toString() < floor.toString() ? floor : checkpoint[lane];
        const rows = await collection.find({ _id: { $gt: cursor, ...(lane === 'replay' ? { $lte: checkpoint.highwater } : {}) } }, { projection: { _id: 1 }, maxTimeMS: 3000 }).sort({ _id: 1 }).limit(4).toArray();
        for (const metadata of rows) {
          if (!this.authorized()) throw new FacesError('faces_capture_license_unavailable', '抓拍授权已失效', 503);
          const fresh = (await this.sources()).find(s => s.processor_id === source.processor_id && s.channel_id === source.channel_id);
          if (!fresh?.capture_supported || fresh.source_revision !== source.source_revision) throw new FacesError('faces_archive_source_changed', '抓拍来源配置已变化', 503);
          const row = await collection.findOne({ _id: metadata._id }, { projection: { image: 0, embedding: 0 }, maxTimeMS: 3000 });
          const capture = row && row.timestamp * 1000 >= checkpoint.started_at.getTime() ? facesArchiveCapture(row, source, status.active_model) : null;
          let reason = 'archive_identity_or_original_unavailable';
          if (capture) {
            const track = hash([source.source_revision, capture.session_id, capture.track_id, status.spaces.find(s => s.model === status.active_model)?.space_id]);
            const previous = await tracks.findOne({ _id: track });
            const skipped = await tracks.findOne({ _id: hash(['failed-frame', source.source_revision, capture.frame_id, capture.track_id]) });
            if (!skipped && !previous?.qualified && (previous?.attempts ?? 0) < 3) {
              // Runtime commits the history and durable outbox before this cursor.
              // Failure leaves the cursor in place; retries reuse frame identity.
              try {
                const result = await this.runtime.capture(capture, source.retention_days);
                await tracks.updateOne({ _id: track }, { $set: { qualified: result.record.quality.state === 'qualified', record_id: result.record.id, expires_at: new Date(result.record.expires_at) }, $addToSet: { frames: capture.frame_id } }, { upsert: true, writeConcern: { w: 1, j: true } });
                const updated = await tracks.findOne({ _id: track });
                await tracks.updateOne({ _id: track }, { $set: { attempts: updated?.frames?.length ?? 1 } });
              } catch (error) {
                const reason = error instanceof FacesError ? error.code : 'faces_capture_dependency_unavailable';
                const permanent = error instanceof FacesError && [400, 409, 410, 422].includes(error.statusCode);
                const frame = metadata._id.toString();
                const first = checkpoint.failed_frame === frame ? checkpoint.first_failed_at as Date : new Date();
                const exhausted = Date.now() - first.getTime() >= 300000;
                // One failure slot per source, no unbounded retry-task collection.
                await checkpoints.updateOne({ _id: key, owner: this.owner }, { $set: { failed_frame: frame, first_failed_at: first, failure_reason: reason, coverage: 'partial' } }, { writeConcern: { w: 1, j: true } });
                if (!permanent && !exhausted) throw error;
                await checkpoints.updateOne({ _id: key, owner: this.owner }, { $inc: { failed_samples: 1 }, $set: { last_failed_frame: frame, last_failure_reason: reason } });
                // Poison frames remain deduplicated through the five-minute replay.
                await tracks.updateOne({ _id: hash(['failed-frame', source.source_revision, capture.frame_id, capture.track_id]) }, { $set: { skipped: true, expires_at: new Date(Date.now() + 600000) } }, { upsert: true });
              }
            }
            reason = 'sampled';
          }
          const advanced = await checkpoints.updateOne({ _id: key, owner: this.owner, lease_until: { $gt: new Date() }, revision: source.source_revision }, { $set: { [lane]: metadata._id, reason, updated_at: new Date() }, $unset: { failed_frame: '', first_failed_at: '' } }, { writeConcern: { w: 1, j: true } });
          if (!advanced.matchedCount) throw new FacesError('faces_archive_lease_expired', '抓拍游标租约已失效', 503);
          checkpoint[lane] = metadata._id;
        }
        if (lane === 'replay' && rows.length < 4) await checkpoints.updateOne({ _id: key, owner: this.owner }, { $set: { replay: floor } });
      }
    } finally { await checkpoints.updateOne({ _id: key, owner: this.owner }, { $set: { lease_until: new Date(0) } }); }
  }
}
