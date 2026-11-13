import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Db, Document, Filter } from 'mongodb';
import { FacesMongo, FACES_HISTORY_INDEX, facesCosine, facesVector, type FacesMongoRow } from '../store/facesMongo.js';
import type { FacesNativeClient } from './facesNativeClient.js';
import type { FacesPhotos } from './facesPhotos.js';
import { FacesError, facesUnavailable, facesId, facesModel, facesPin, facesTemplateSchema, facesRecordSchema, facesHistoryQuerySchema,
  type FacesModel, type FacesStatus, type FacesTemplate, type FacesRecord, type FacesPage, type FacesSearchPage, type FacesLibrary, type FacesDiagnostic } from './facesContract.js';
import { searchRangeSchema } from './searchContract.js';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const actorSchema = z.literal('console-administrator');
const nativeInput = z.object({ request_id: facesId, actor: actorSchema, model: facesModel, space_id: facesPin, jpeg_base64: z.string().max(6 * 1024 * 1024), jpeg_sha256: facesPin, deadline_ms: z.number().int() });
const enrollSchema = nativeInput.extend({ library_id: facesId, member_id: facesId, retention_days: z.number().int().min(1).max(90), expires_at: z.string().datetime({ offset: true }) }).strict();
const querySchema = nativeInput.extend({ scope: searchRangeSchema, limit: z.number().int().min(1).max(50) }).strict();
export const facesCaptureSchema = z.object({
  request_id: facesId, model: facesModel.default('mbf'), jpeg_base64: z.string().max(6 * 1024 * 1024),
  channel_id: facesId, processor_id: z.string().min(1).max(128), session_id: z.string().min(1).max(128), track_id: z.string().max(128),
  frame_id: z.string().min(1).max(256), source_pts_ns: z.string().regex(/^\d{1,20}$/), source_frame_index: z.string().regex(/^\d{1,20}$/),
  captured_at: z.string().datetime({ offset: true }), recording_channel_id: facesId.nullable(),
}).strict();
type QueryRow = Document & { _id: string; actor: string; state: string; fingerprint?: string; results?: { id: string; fingerprint: string; similarity: number }[]; expires_at: Date };
type SpaceRow = Document & { _id: string; model?: FacesModel; space_id: string };
export interface FacesWatchlistCandidate { event_id: string; kind: 'face_watchlist_candidate'; event_kind: 'face_watchlist'; review_required: true; semantics_version: 'faces-watchlist-v1';
  processor_id: string; channel_id: string; session_id: string; track_id: string; frame_id: string; source_pts_ns: string; source_frame_index: string; occurred_at: string; record_id: string; photo_ref: string;
  library_name: string; member_name: string; library_id: string; library_version: number; member_id: string; model: FacesModel; space_id: string;
  recording_channel_id: string | null; similarity: number; threshold: number; accuracy_verified: false }
const geometric = { state: 'qualified' as const, reason: '仅通过几何门槛；模糊、遮挡、活体和识别精度均未验证' };
const expired = () => new FacesError('evidence_expired', '照片或特征已过保留期', 410);
function image(value: string) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new FacesError('invalid_image', 'JPEG编码无效');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 4 || bytes.length > 4 * 1024 * 1024 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new FacesError('invalid_image', '照片须为4MB以内的JPEG');
  return bytes;
}
/** Node business owner. Hardware knows no PG/Mongo/library/search semantics. */
export class FacesRuntime {
  private busy = false;
  private spaceRecovery: Promise<void> | null = null;
  constructor(private readonly mongo: FacesMongo, private readonly photos: Pick<FacesPhotos, 'publish' | 'read' | 'remove'> & Partial<Pick<FacesPhotos, 'cleanup'>>,
    private readonly extractor: Pick<FacesNativeClient, 'status' | 'extract'>,
    private readonly libraries: () => Promise<FacesLibrary[]> = async () => [],
    private readonly diagnostics: () => FacesDiagnostic[] = () => []) {}
  async status(): Promise<FacesStatus> {
    const db = await this.mongo.db();
    let unavailableReason = 'extractor_unavailable';
    const status = await this.extractor.status().catch(error => { unavailableReason = error instanceof FacesError ? error.code : 'faces_configuration_unavailable'; return null; });
    // Share the startup recovery between concurrent pollers. A rejected recovery
    // is retryable; successful recovery never scans captures again in this instance.
    if (!this.spaceRecovery) this.spaceRecovery = this.recoverSpaces(db).catch(error => { this.spaceRecovery = null; throw error; });
    await this.spaceRecovery;
    const activeModel = status?.embedding_model === 'face-embed-mbf' ? 'mbf' : status?.embedding_model === 'face-embed-r50' ? 'r50' : null;
    const activePin = facesPin.safeParse(status?.model_space_hash);
    const registry = db.collection<SpaceRow>('faces_spaces');
    if (activeModel && activePin.success) await registry.updateOne({ _id: `${activeModel}:${activePin.data}` }, { $setOnInsert: { model: activeModel, space_id: activePin.data } }, { upsert: true });
    const saved = await registry.find({}).limit(20001).toArray();
    if (saved.length > 20000) throw new FacesError('faces_space_capacity', '历史模型空间超过上限，未删除历史', 503);
    const spaces = new Map<string, { model: FacesModel; space_id: string }>();
    for (const row of saved) {
      const model = facesModel.safeParse(row.model ?? row._id), pin = facesPin.safeParse(row.space_id);
      if (model.success && pin.success) spaces.set(`${model.data}:${pin.data}`, { model: model.data, space_id: pin.data });
    }
    return { ready: !!status?.can_extract, reason: status?.can_extract ? null : status?.reason ?? unavailableReason, accuracy_verified: false,
      active_model: status?.can_extract && status.embedding_model ? status.embedding_model === 'face-embed-mbf' ? 'mbf' : 'r50' : null,
      desired_model: status?.configuration ? status.configuration.embedding_model === 'face-embed-mbf' ? 'mbf' : 'r50' : null,
      diagnostics: this.diagnostics(),
      spaces: [...spaces.values()].map(space => ({ ...space, active: space.model === activeModel && space.space_id === status?.model_space_hash, dimensions: 512, alignment_version: 'arcface112-rgb8-similarity5-gles-v1', metric: 'cosine' as const }))
        // Older producers select the first matching model; keep that compatible.
        .sort((a, b) => Number(b.active) - Number(a.active) || a.model.localeCompare(b.model) || a.space_id.localeCompare(b.space_id)) };
  }
  private async recoverSpaces(db: Db): Promise<void> {
    const registry = db.collection<SpaceRow>('faces_spaces');
    const saved = await registry.find({}).limit(20001).toArray();
    if (saved.length > 20000) throw new FacesError('faces_space_capacity', '历史模型空间超过上限，未删除历史', 503);
    // Preserve old model-keyed rows and recover pins overwritten by older releases
    // from retained records. No vectors or photos are read or rewritten here.
    const retained = await db.collection<FacesMongoRow>('faces_records').aggregate<{ _id: { model: FacesModel; space_id: string } }>([
      { $match: { state: 'ready', expires_at: { $gt: new Date() } } },
      { $group: { _id: { model: '$model', space_id: '$space_id' } } }, { $limit: 20001 },
    ], { maxTimeMS: 3000 }).toArray();
    const spaces = new Map<string, { model: FacesModel; space_id: string }>();
    const add = (model: unknown, pin: unknown) => {
      const parsedModel = facesModel.safeParse(model), parsedPin = facesPin.safeParse(pin);
      if (parsedModel.success && parsedPin.success) spaces.set(`${parsedModel.data}:${parsedPin.data}`, { model: parsedModel.data, space_id: parsedPin.data });
    };
    for (const row of saved) add(row.model ?? row._id, row.space_id);
    for (const row of retained) add(row._id.model, row._id.space_id);
    if (retained.length > 20000 || spaces.size > 20000) throw new FacesError('faces_space_capacity', '历史模型空间超过上限，未删除历史', 503);
    const existing = new Set(saved.map(row => row._id));
    for (const [id, space] of spaces) if (!existing.has(id)) {
      await registry.updateOne({ _id: id }, { $setOnInsert: space }, { upsert: true });
    }
  }
  private async extract(bytes: Buffer, model: FacesModel, space: string, requestId: string) {
    const status = await this.extractor.status();
    if (!status.can_extract || !status.model_space_hash || !status.detector_sha256) throw facesUnavailable();
    if (status.embedding_model !== (model === 'mbf' ? 'face-embed-mbf' : 'face-embed-r50') || status.model_space_hash !== space) throw new FacesError('model_space_mismatch', '当前硬件模型与所选空间不一致，不能混用MBF与R50', 409);
    const result = await this.extractor.extract(bytes, { request_id: requestId, model_space_hash: space, detector_sha256: status.detector_sha256, jpeg_sha256: sha(bytes), expires_ms: Date.now() + 30000 });
    if (result.status !== 'extracted' || !result.embedding) throw new FacesError('quality_rejected', result.status === 'multiple_faces' ? '照片包含多个人脸，请选择单人照片' : result.status === 'no_face' ? '没有检测到可用人脸，请更换照片' : '照片未通过几何质量检查，请更换照片', 422);
    return result.embedding;
  }
  private async bounded<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw new FacesError('faces_busy', '人脸处理繁忙，请稍后重试', 429);
    this.busy = true; try { return await work(); } finally { this.busy = false; }
  }
  private async maintain(db: Db) {
    const rows = db.collection<FacesMongoRow>('faces_records');
    for await (const row of rows.find({ state: { $ne: 'expired' }, expires_at: { $lte: new Date() } }).limit(32)) {
      await rows.updateOne({ _id: row._id }, { $set: { state: 'deleting' } });
      if (row.photo) await this.photos.remove(row.photo);
      await rows.updateOne({ _id: row._id }, { $set: { state: 'expired', purge_at: new Date(Date.now() + 90 * 86400000) }, $unset: { vector: '', photo: '' } });
    }
    if (this.photos.cleanup) {
      const retained = await rows.find({ state: { $ne: 'expired' } }, { projection: { _id: 1 }, maxTimeMS: 3000 }).limit(20001).toArray();
      if (retained.length <= 20000) await this.photos.cleanup(new Set(retained.map(row => row._id)));
    }
  }
  async maintainStorage() { return this.bounded(() => this.mongo.write(db => this.maintain(db))); }
  private async persist(kind: 'template' | 'capture', id: string, fingerprint: string, data: Record<string, unknown>, bytes: Buffer, requestId: string, model: FacesModel, space: string, expires: Date, libraryVersions?: { id: string; version: number }[]) {
    return this.mongo.write(async db => {
      await this.maintain(db);
      const records = db.collection<FacesMongoRow>('faces_records');
      let row = await records.findOne({ _id: id });
      if (row && (row.fingerprint !== fingerprint || row.kind !== kind)) throw new FacesError('idempotency_conflict', '同一请求或帧标识已用于不同内容', 409);
      if (row && (row.expires_at.getTime() <= Date.now() || ['expired', 'deleting'].includes(row.state))) throw expired();
      if (row?.state === 'ready') return row;
      if (!row) {
        if (await records.countDocuments({ state: { $ne: 'expired' } }, { limit: 20000 }) >= 20000) throw new FacesError('faces_history_capacity', '人脸记录已达容量上限', 429);
        await records.insertOne({ _id: id, kind, fingerprint, model, space_id: space, state: 'pending', expires_at: expires, data, ...(libraryVersions ? { library_versions: libraryVersions } : {}) }, { writeConcern: { w: 1, j: true } });
        row = await records.findOne({ _id: id });
      }
      if (row?.state === 'pending') {
        let vector: number[] | undefined;
        try { vector = await this.extract(bytes, model, space, requestId); }
        catch (error) {
          if (kind !== 'capture' || !(error instanceof FacesError) || error.code !== 'quality_rejected') throw error;
          await this.mongo.assertWriter(db);
          await records.updateOne({ _id: id, fingerprint, state: 'pending' }, { $set: { 'data.quality': { state: 'rejected', reason: error.message }, 'data.match': { state: 'unavailable', reason: 'quality_rejected_no_identity_comparison' }, state: 'extracted' } }, { writeConcern: { w: 1, j: true } });
        }
        await this.mongo.assertWriter(db);
        if (vector) await records.updateOne({ _id: id, fingerprint, state: 'pending' }, { $set: { vector: facesVector(vector), state: 'extracted' } }, { writeConcern: { w: 1, j: true } });
      }
      const photo = await this.photos.publish(id, bytes);
      await this.mongo.assertWriter(db);
      await records.updateOne({ _id: id, fingerprint, state: 'extracted' }, { $set: { photo, state: 'ready' } }, { writeConcern: { w: 1, j: true } });
      const saved = await records.findOne({ _id: id });
      if (!saved || saved.state !== 'ready' || (kind === 'template' && !saved.vector)) throw new FacesError('faces_write_unconfirmed', '人脸写入尚未确认，请保留原请求重试', 503);
      return saved;
    });
  }
  async enroll(raw: unknown): Promise<FacesTemplate> {
    const input = enrollSchema.parse(raw), bytes = image(input.jpeg_base64);
    if (sha(bytes) !== input.jpeg_sha256 || input.deadline_ms <= Date.now()) throw new FacesError('invalid_image', '上传图像或期限无效');
    const expires = new Date(Math.min(Date.parse(input.expires_at), Date.now() + input.retention_days * 86400000));
    if (expires.getTime() <= Date.now()) throw expired();
    // Deadline changes across retries; identity hashes only immutable request semantics.
    const fingerprint = sha(JSON.stringify([input.actor, input.library_id, input.member_id, input.model, input.space_id, input.jpeg_sha256, input.retention_days]));
    return this.bounded(async () => {
      const row = await this.persist('template', input.request_id, fingerprint, {
        template_id: input.request_id, photo_ref: input.request_id, actor: input.actor, library_id: input.library_id, member_id: input.member_id,
        request_id: input.request_id, model: input.model, space_id: input.space_id, quality: geometric, jpeg_sha256: input.jpeg_sha256, expires_at: expires.toISOString(),
      }, bytes, input.request_id, input.model, input.space_id, expires);
      return facesTemplateSchema.parse(row.data);
    });
  }
  async template(raw: unknown): Promise<FacesTemplate> {
    const input = z.object({ template_id: facesId, actor: actorSchema }).strict().parse(raw);
    const row = await (await this.mongo.db()).collection<FacesMongoRow>('faces_records').findOne({ _id: input.template_id, kind: 'template', state: 'ready', 'data.actor': input.actor }, { projection: { data: 1, expires_at: 1 } });
    if (!row || row.expires_at.getTime() <= Date.now()) throw expired();
    return facesTemplateSchema.parse(row.data);
  }
  async capture(raw: unknown, retentionDays: number): Promise<{ record: FacesRecord; watchlist_candidates: FacesWatchlistCandidate[] }> {
    const input = facesCaptureSchema.parse(raw), status = await this.status(), space = status.spaces.find(value => value.model === input.model && value.active)?.space_id;
    input.captured_at = new Date(input.captured_at).toISOString();
    // A previously committed capture/outbox can be retried while hardware is
    // offline. New extraction still checks can_extract in extract().
    if (!space) throw facesUnavailable();
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 90 || Date.parse(input.captured_at) > Date.now() + 5000) throw new FacesError('invalid_capture', '抓拍保留期或源时间无效');
    const expires = new Date(Date.parse(input.captured_at) + retentionDays * 86400000); if (expires.getTime() <= Date.now()) throw expired();
    const bytes = image(input.jpeg_base64);
    const identity = sha(JSON.stringify(['face-capture-v1', input.channel_id, input.processor_id, input.session_id, input.track_id, input.frame_id, input.source_pts_ns, input.source_frame_index, space]));
    const id = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-8${identity.slice(13, 16)}-a${identity.slice(17, 20)}-${identity.slice(20, 32)}`;
    const fingerprint = sha(JSON.stringify([identity, sha(bytes), input.captured_at, retentionDays]));
    return this.bounded(async () => {
      const libraries = (await this.libraries()).filter(library => library.document.match_requested && library.document.model === input.model && library.document.channel_ids.includes(input.channel_id) && Date.parse(library.document.valid_until) > Date.now() && Date.parse(library.updated_at) <= Date.parse(input.captured_at));
      const row = await this.persist('capture', id, fingerprint, {
        id, channel_id: input.channel_id, processor_id: input.processor_id, session_id: input.session_id, track_id: input.track_id,
        captured_at: input.captured_at, expires_at: expires.toISOString(), model: input.model, space_id: space, quality: geometric, photo_ref: id,
        match: { state: 'unavailable', reason: 'identity_matching_not_enabled' }, recording_channel_id: input.recording_channel_id,
      }, bytes, input.request_id, input.model, space, expires, libraries.map(library => ({ id: library.id, version: library.version })));
      return this.matchCapture(row, input);
    });
  }
  private async matchCapture(row: FacesMongoRow, source: z.infer<typeof facesCaptureSchema>) {
    if (!row.vector) return { record: facesRecordSchema.parse(row.data), watchlist_candidates: [] };
    const current = await this.libraries(), pins = row.library_versions as { id: string; version: number }[] | undefined;
    if (row.watchlist_done) {
      const candidates = ((row.watchlist_candidates ?? []) as FacesWatchlistCandidate[]).filter(candidate => current.some(library => library.id === candidate.library_id && library.version === candidate.library_version && library.document.match_requested && library.document.channel_ids.includes(source.channel_id) && Date.parse(library.document.valid_until) > Date.now()));
      return { record: facesRecordSchema.parse(row.data), watchlist_candidates: candidates };
    }
    const libraries = current.filter(library => pins?.some(pin => pin.id === library.id && pin.version === library.version) && library.document.match_requested && library.document.match_threshold !== null && library.document.model === row.model && library.document.channel_ids.includes(source.channel_id) && Date.parse(library.document.valid_until) > Date.now());
    const records = (await this.mongo.db()).collection<FacesMongoRow>('faces_records');
    const templateIds = libraries.flatMap(library => library.document.members.map(member => member.template_id).filter((value): value is string => !!value));
    const templates = templateIds.length ? await records.find({ _id: { $in: templateIds }, kind: 'template', state: 'ready', model: row.model, space_id: row.space_id, expires_at: { $gt: new Date() } }, { projection: { vector: 1 }, maxTimeMS: 3000 }).limit(501).toArray() : [];
    if (templates.length > 500 || !row.vector) throw new FacesError('faces_feature_unavailable', '名单特征超出容量或不可用', 503);
    const bytes = Buffer.from(row.vector.buffer), vector = Array.from({ length: 512 }, (_, index) => bytes.readFloatLE(index * 4));
    const available = new Map(templates.map(template => [template._id, template]));
    const candidates: FacesWatchlistCandidate[] = []; let compared = false;
    for (const library of libraries) {
      const ranked = library.document.members.flatMap(member => { const template = member.template_id ? available.get(member.template_id) : null; if (!template?.vector) return []; compared = true; return [{ member, score: facesCosine(template.vector, vector) }]; }).sort((a, b) => b.score - a.score || a.member.id.localeCompare(b.member.id));
      const best = ranked[0]; if (!best || best.score < library.document.match_threshold!) continue;
      candidates.push({ event_id: sha(JSON.stringify(['faces-watchlist-v1', source.channel_id, source.session_id, source.track_id || source.frame_id, library.id, library.version, best.member.id])), kind: 'face_watchlist_candidate', event_kind: 'face_watchlist', review_required: true, semantics_version: 'faces-watchlist-v1',
        processor_id: source.processor_id, channel_id: source.channel_id, session_id: source.session_id, track_id: source.track_id, frame_id: source.frame_id, source_pts_ns: source.source_pts_ns, source_frame_index: source.source_frame_index, occurred_at: source.captured_at, record_id: row._id, photo_ref: row._id,
        library_name: library.document.name, member_name: best.member.name, library_id: library.id, library_version: library.version, member_id: best.member.id, model: row.model, space_id: row.space_id, recording_channel_id: source.recording_channel_id, similarity: best.score, threshold: library.document.match_threshold!, accuracy_verified: false });
    }
    candidates.sort((a, b) => b.similarity - a.similarity || a.event_id.localeCompare(b.event_id));
    const best = candidates[0];
    const match: FacesRecord['match'] = best ? { state: 'candidate', reason: 'operator_threshold_candidate_not_identity_confirmation', library_id: best.library_id, library_version: best.library_version, member_id: best.member_id, similarity: best.similarity, threshold: best.threshold, accuracy_verified: false }
      : compared && available.size === new Set(templateIds).size && libraries.length === pins?.length ? { state: 'unmatched', reason: 'below_configured_threshold_not_stranger' } : { state: 'unavailable', reason: 'no_eligible_templates_or_configuration_changed' };
    // The outbox is committed WITH the immutable candidate facts. Alarm delivery
    // is a separate idempotent ACK, never a reason to roll back a ready capture.
    const saved = await records.updateOne({ _id: row._id, fingerprint: row.fingerprint, state: 'ready', expires_at: { $gt: new Date() }, watchlist_done: { $ne: true } }, { $set: { 'data.match': match, watchlist_done: true, watchlist_candidates: candidates, watchlist_pending: candidates.length > 0, watchlist_delivered: [] } }, { writeConcern: { w: 1, j: true } });
    if (!saved.matchedCount) throw new FacesError('faces_match_unconfirmed', '候选结果保存尚未确认，请使用原帧请求重试', 503);
    return { record: facesRecordSchema.parse({ ...row.data, match }), watchlist_candidates: candidates };
  }
  async watchlistOutbox(limit = 20): Promise<{ items: FacesWatchlistCandidate[] }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new FacesError('invalid_limit', '待投递批次须为1至50');
    const libraries = await this.libraries(), records = (await this.mongo.db()).collection<FacesMongoRow>('faces_records');
    const items: FacesWatchlistCandidate[] = [];
    const rows = await records.find({ kind: 'capture', state: 'ready', watchlist_pending: true, expires_at: { $gt: new Date() } }, { projection: { watchlist_candidates: 1, watchlist_delivered: 1, watchlist_suppressed: 1 }, maxTimeMS: 3000 }).sort({ _id: 1 }).limit(50).toArray();
    for (const row of rows) {
      const candidates = (row.watchlist_candidates ?? []) as FacesWatchlistCandidate[];
      const delivered = new Set<string>([...(row.watchlist_delivered ?? []), ...(row.watchlist_suppressed ?? [])]);
      const pending = candidates.filter(candidate => !delivered.has(candidate.event_id));
      const active = pending.filter(candidate => libraries.some(library => library.id === candidate.library_id && library.version === candidate.library_version && library.document.match_requested && library.document.model === candidate.model && library.document.channel_ids.includes(candidate.channel_id) && Date.parse(library.document.valid_until) > Date.now()));
      // Revoked/changed configuration cannot generate a delayed new alarm.
      const revoked = pending.filter(candidate => !active.includes(candidate)).map(candidate => candidate.event_id);
      if (revoked.length) await records.updateOne({ _id: row._id }, { $addToSet: { watchlist_suppressed: { $each: revoked } }, $set: { watchlist_revoked_at: new Date() } }, { writeConcern: { w: 1, j: true } });
      if (!active.length) await records.updateOne({ _id: row._id }, { $set: { watchlist_pending: false } });
      items.push(...active.slice(0, limit - items.length));
      if (items.length >= limit) break;
    }
    return { items };
  }
  async acknowledgeWatchlist(raw: unknown) {
    const input = z.object({ record_id: facesId, event_id: facesPin }).strict().parse(raw);
    const records = (await this.mongo.db()).collection<FacesMongoRow>('faces_records');
    const row = await records.findOne({ _id: input.record_id, kind: 'capture', 'watchlist_candidates.event_id': input.event_id }, { projection: { watchlist_candidates: 1, watchlist_delivered: 1 } });
    if (!row) throw new FacesError('faces_candidate_missing', '候选引用不存在或已到期', 404);
    await records.updateOne({ _id: row._id }, { $addToSet: { watchlist_delivered: input.event_id }, $set: { watchlist_last_ack_at: new Date() } }, { writeConcern: { w: 1, j: true } });
    return { acknowledged: true as const, record_id: input.record_id, event_id: input.event_id };
  }
  async history(raw: unknown): Promise<FacesPage> {
    const input = facesHistoryQuerySchema.extend({ actor: actorSchema }).strict().parse(raw);
    input.scope.from = new Date(input.scope.from).toISOString(); input.scope.to = new Date(input.scope.to).toISOString();
    const scopeHash = sha(JSON.stringify([input.scope, input.model, input.space_id]));
    let after: { at: string; id: string } | null = null;
    if (input.cursor) {
      try { const value = z.object({ at: z.string().datetime({ offset: true }), id: facesId, scope: facesPin }).strict().parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString())); if (value.scope !== scopeHash) throw Error(); after = value; }
      catch { throw new FacesError('invalid_cursor', '分页范围已变化，请重新查询'); }
    }
    const filter: Filter<FacesMongoRow> = { kind: 'capture', state: 'ready', model: input.model, ...(input.space_id ? { space_id: input.space_id } : {}), expires_at: { $gt: new Date() },
      'data.channel_id': { $in: input.scope.channel_ids }, 'data.captured_at': { $gte: input.scope.from, $lt: input.scope.to },
      ...(after ? { $or: [{ 'data.captured_at': { $lt: after.at } }, { 'data.captured_at': after.at, _id: { $gt: after.id } }] } : {}) };
    const rows = await (await this.mongo.db()).collection<FacesMongoRow>('faces_records').find(filter, { projection: { data: 1 }, maxTimeMS: 3000,
      // Omitting space_id would leave a gap in the original vector-space index.
      ...(input.space_id ? {} : { hint: FACES_HISTORY_INDEX }),
    }).sort({ 'data.captured_at': -1, _id: 1 }).limit(input.limit + 1).toArray();
    const items = rows.slice(0, input.limit).map(row => facesRecordSchema.parse(row.data)), last = items.at(-1);
    return { scope: input.scope, model: input.model, space_id: input.space_id ?? null, items,
      next_cursor: rows.length > input.limit && last ? Buffer.from(JSON.stringify({ at: last.captured_at, id: last.id, scope: scopeHash })).toString('base64url') : null, coverage: 'unknown' };
  }
  async record(raw: unknown): Promise<FacesRecord> {
    const input = z.object({ id: facesId, actor: actorSchema, channel_ids: z.array(facesId).max(100) }).strict().parse(raw);
    const row = await (await this.mongo.db()).collection<FacesMongoRow>('faces_records').findOne({ _id: input.id, kind: 'capture', state: 'ready', 'data.channel_id': { $in: input.channel_ids } }, { projection: { data: 1, expires_at: 1 } });
    if (!row || row.expires_at.getTime() <= Date.now()) throw expired();
    return facesRecordSchema.parse(row.data);
  }
  async referenceCandidate(raw: unknown): Promise<FacesWatchlistCandidate> {
    const input = z.object({ actor: actorSchema, record_id: facesId, library_id: facesId, library_version: z.number().int().positive(), member_id: facesId, channel_ids: z.array(facesId).max(100) }).strict().parse(raw);
    const row = await (await this.mongo.db()).collection<FacesMongoRow>('faces_records').findOne({ _id: input.record_id, kind: 'capture', state: 'ready', 'data.channel_id': { $in: input.channel_ids } }, { projection: { data: 1, expires_at: 1, watchlist_done: 1, watchlist_candidates: 1 } });
    if (!row || row.expires_at.getTime() <= Date.now()) throw expired();
    const record = facesRecordSchema.parse(row.data);
    const candidate = (row.watchlist_candidates as FacesWatchlistCandidate[] | undefined)?.find(value => value.library_id === input.library_id && value.library_version === input.library_version && value.member_id === input.member_id);
    if (!row.watchlist_done || !candidate || candidate.kind !== 'face_watchlist_candidate' || candidate.record_id !== record.id || candidate.channel_id !== record.channel_id || candidate.model !== record.model || candidate.space_id !== record.space_id || candidate.recording_channel_id !== record.recording_channel_id || (record.recording_channel_id && !input.channel_ids.includes(record.recording_channel_id)))
      throw new FacesError('faces_reference_mismatch', '历史候选事实与参考照片引用不一致', 409);
    return candidate;
  }
  async image(raw: unknown): Promise<Buffer> {
    const input = z.object({ actor: actorSchema, photo_ref: facesId, template_id: facesId.optional(), record_id: facesId.optional() }).strict().parse(raw);
    const id = input.template_id ?? input.record_id;
    if (!id || input.photo_ref !== id) throw new FacesError('faces_scope_denied', '照片引用不属于此记录', 403);
    const row = await (await this.mongo.db()).collection<FacesMongoRow>('faces_records').findOne({ _id: id, state: 'ready', ...(input.template_id ? { kind: 'template', 'data.actor': input.actor } : { kind: 'capture' }) }, { projection: { photo: 1, expires_at: 1 } });
    if (!row?.photo || row.expires_at.getTime() <= Date.now()) throw expired();
    const bytes = await this.photos.read(row.photo);
    if (row.expires_at.getTime() <= Date.now()) throw expired();
    return bytes;
  }
  async search(raw: unknown): Promise<FacesSearchPage> {
    const input = querySchema.parse(raw), bytes = image(input.jpeg_base64);
    input.scope.from = new Date(input.scope.from).toISOString(); input.scope.to = new Date(input.scope.to).toISOString();
    if (sha(bytes) !== input.jpeg_sha256) throw new FacesError('invalid_image', '查询图片散列不一致');
    return this.bounded(async () => {
      const db = await this.mongo.db(), queries = db.collection<QueryRow>('faces_query_states'), records = db.collection<FacesMongoRow>('faces_records');
      const key = `${input.actor}:${input.request_id}`, fingerprint = sha(JSON.stringify([input.actor, input.scope, input.model, input.space_id, input.limit, input.jpeg_sha256]));
      let query = await queries.findOne({ _id: key });
      if (query && query.expires_at.getTime() <= Date.now()) throw new FacesError('cancelled', '搜索已过期，请使用新请求查询', 410);
      if (query?.state === 'cancelled') throw new FacesError('cancelled', '搜索已取消', 410);
      if (query && query.fingerprint !== fingerprint) throw new FacesError('idempotency_conflict', '此搜索编号已用于其他条件', 409);
      if (!query) {
        if (await queries.countDocuments({}, { limit: 1000 }) >= 1000) throw new FacesError('faces_query_capacity', '搜索会话已达上限，请稍后重试', 429);
        await queries.updateOne({ _id: key }, { $setOnInsert: { actor: input.actor, fingerprint, state: 'pending', expires_at: new Date(Date.now() + 3600000) } }, { upsert: true });
      }
      if (query?.state !== 'complete') {
        const vector = await this.extract(bytes, input.model, input.space_id, input.request_id);
        const rows = await records.find({ kind: 'capture', state: 'ready', 'data.quality.state': 'qualified', model: input.model, space_id: input.space_id, expires_at: { $gt: new Date() },
          'data.channel_id': { $in: input.scope.channel_ids }, 'data.captured_at': { $gte: input.scope.from, $lt: input.scope.to } }, { projection: { vector: 1, fingerprint: 1 }, maxTimeMS: 3000 }).limit(2049).toArray();
        if (rows.length > 2048) throw new FacesError('faces_query_scope_too_large', '范围超过2048条抓拍，请缩短时间或减少通道后查询', 422);
        const results = rows.map(row => { if (!row.vector) throw new FacesError('faces_feature_unavailable', '部分历史特征不可用', 503); return { id: row._id, fingerprint: row.fingerprint, similarity: facesCosine(row.vector, vector) }; })
          .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id)).slice(0, input.limit);
        const saved = await queries.updateOne({ _id: key, fingerprint, state: { $ne: 'cancelled' }, expires_at: { $gt: new Date() } }, { $set: { state: 'complete', results } });
        if (!saved.matchedCount) throw new FacesError('cancelled', '搜索已取消或过期', 410);
        query = await queries.findOne({ _id: key });
      }
      if (!query || query.state !== 'complete' || query.expires_at.getTime() <= Date.now()) throw new FacesError('cancelled', '搜索已取消或过期', 410);
      const items: FacesRecord[] = [];
      for (const result of query.results ?? []) {
        const row = await records.findOne({ _id: result.id, fingerprint: result.fingerprint, state: 'ready', expires_at: { $gt: new Date() }, 'data.channel_id': { $in: input.scope.channel_ids } }, { projection: { data: 1 } });
        if (row) items.push({ ...facesRecordSchema.parse(row.data), similarity: result.similarity });
      }
      return { query_id: input.request_id, quality: geometric, scope: input.scope, model: input.model, space_id: input.space_id, items, next_cursor: null, coverage: 'unknown' };
    });
  }
  async cancel(raw: unknown) {
    const input = z.object({ request_id: facesId, actor: actorSchema }).strict().parse(raw);
    const queries = (await this.mongo.db()).collection<QueryRow>('faces_query_states');
    if (!await queries.findOne({ _id: `${input.actor}:${input.request_id}` }) && await queries.countDocuments({}, { limit: 1000 }) >= 1000) throw new FacesError('faces_query_capacity', '搜索会话已达上限', 429);
    await queries.updateOne({ _id: `${input.actor}:${input.request_id}` }, { $set: { actor: input.actor, state: 'cancelled', expires_at: new Date(Date.now() + 3600000) }, $unset: { results: '' } }, { upsert: true });
    return { cancelled: true as const };
  }
  async close() { await this.mongo.close(); }
}
