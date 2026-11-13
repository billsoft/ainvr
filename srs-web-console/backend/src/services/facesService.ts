import { createHash } from 'node:crypto';
import { sameSearchScope } from './searchContract.js';
import type { SearchScope } from './searchContract.js';
import type { SearchSourceChannel } from './searchSourceCatalog.js';
import type { FacesStore } from '../store/facesStore.js';
import type { FacesRuntime } from './facesRuntime.js';
import { FacesError, facesUnavailable, facesId, facesVersion, facesReferenceSchema, facesSaveSchema, facesUploadSchema, facesHistoryQuerySchema, facesSearchQuerySchema,
  type FacesLibrary, type FacesTemplate, type FacesModel, type FacesPage, type FacesRecord } from './facesContract.js';

type Store = Pick<FacesStore, 'get' | 'getVersion' | 'list' | 'save' | 'delete'>;
export type FacesBusinessPort = Pick<FacesRuntime, 'status' | 'enroll' | 'template' | 'history' | 'record' | 'referenceCandidate' | 'search' | 'cancel' | 'image'>;
const expired = () => new FacesError('evidence_expired', '照片或特征已过保留期，请重新上传；未匹配不等于陌生人。', 410);
const invalid = () => new FacesError('faces_business_invalid_response', '人脸服务返回范围或引用不一致，暂不采信', 503);
const publicTemplate = (template: FacesTemplate) => ({ template_id: template.template_id, photo_ref: template.photo_ref, model: template.model, space_id: template.space_id, quality: template.quality, expires_at: template.expires_at });
export function facesPublicLibrary(library: FacesLibrary) {
  return { id: library.id, version: library.version, document: library.document, updated_at: library.updated_at,
    templates: Object.fromEntries(Object.entries(library.templates).map(([id, template]) => [id, publicTemplate(template)])),
    permission: 'console-management' as const, configuration_state: 'saved' as const,
    runtime_note: library.document.match_requested ? '已保存比对请求；仅在授权通道有有效抓拍来源、模型就绪且成员照片有效时产生候选。' : '配置已保存，未请求名单比对。抓拍历史独立运行。' };
}
export function facesJpeg(value: string) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new FacesError('invalid_image', '图片须为有效 JPEG');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 4 || bytes.length > 4 * 1024 * 1024 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new FacesError('invalid_image', '请选择不超过4MB的JPEG照片');
  // Structural gate only. Native performs real image/face/quality validation.
  return createHash('sha256').update(bytes).digest('hex');
}
export class FacesService {
  constructor(private readonly store: Store | null, private readonly runtime: FacesBusinessPort,
    readonly channels: (actor: string) => Promise<SearchSourceChannel[]>, private readonly now = Date.now) {}
  private config(): Store { if (!this.store) throw new FacesError('configuration_unavailable', '人脸参数库暂不可用', 503); return this.store; }
  private async authorize(ids: string[], actor: string) {
    const allowed = new Set((await this.channels(actor)).map(channel => channel.id));
    if (ids.some(id => !allowed.has(id))) throw new FacesError('faces_scope_denied', '部分通道不存在或已不可访问；保留输入，请重新选择。', 403);
    return allowed;
  }
  private async space(model: FacesModel) {
    const status = await this.runtime.status();
    const spaces = status.spaces.filter(space => space.model === model && space.active);
    if (!status.ready || spaces.length !== 1) throw facesUnavailable();
    return spaces[0].space_id;
  }
  status() { return this.runtime.status(); }
  async list() { return { items: (await this.config().list()).map(facesPublicLibrary), limits: { libraries: 16, members: 500 }, permission: 'console-management' }; }
  async get(id: string) { return facesPublicLibrary(await this.config().get(id)); }
  async save(id: string, raw: unknown, actor: string, operationKey: string) {
    facesId.parse(id); facesId.parse(operationKey);
    const input = facesSaveSchema.parse(raw);
    const authorized = await this.authorize(input.document.channel_ids, actor);
    let current: FacesLibrary | null = null;
    try { current = await this.config().get(id); } catch (error) { if (!(error instanceof FacesError) || error.code !== 'faces_library_missing') throw error; }
    const templates: Record<string, FacesTemplate> = {};
    let space: string | null = null;
    for (const member of input.document.members) {
      if (!member.template_id) continue;
      const retained = current?.templates[member.id];
      // Preserve original expiry/space on ordinary edits. Changed model means
      // migration required, never silently reinterpret the retained reference.
      if (retained?.template_id === member.template_id) { templates[member.id] = retained; continue; }
      space ??= await this.space(input.document.model);
      const template = await this.runtime.template({ template_id: member.template_id, actor });
      if (template.actor !== actor || template.library_id !== id || template.member_id !== member.id || template.template_id !== member.template_id || template.model !== input.document.model || template.space_id !== space || template.quality.state !== 'qualified') throw new FacesError('faces_template_invalid', '模板不属于当前成员或模型空间，不能入库', 422);
      if (Date.parse(template.expires_at) <= this.now()) throw expired();
      templates[member.id] = template;
    }
    return facesPublicLibrary(await this.config().save(id, input, templates, actor, operationKey, [...authorized]));
  }
  delete(id: string, raw: unknown, actor: string, operationKey: string) { return this.config().delete(id, raw, actor, operationKey); }
  async enroll(id: string, memberId: string, raw: unknown, actor: string) {
    facesId.parse(memberId); const input = facesUploadSchema.parse(raw), library = await this.config().get(id);
    await this.authorize(library.document.channel_ids, actor);
    if (library.version !== input.expected_version) throw new FacesError('version_conflict', '人脸库已更新；照片选择已保留，请核对最新版本。', 409);
    if (!library.document.members.some(member => member.id === memberId)) throw new FacesError('faces_member_missing', '请先保存此成员，再上传照片', 404);
    if (input.model !== library.document.model) throw new FacesError('model_space_mismatch', '上传模型必须与当前库一致', 409);
    const registeredAt = this.now();
    if (Date.parse(library.document.valid_until) <= registeredAt) throw new FacesError('faces_library_expired', '名单有效期已结束，请先修改有效期', 422);
    // New evidence has its own retention clock. Business validity only gates
    // registration/matching; retained receipts keep their original expiry on save.
    const expiresAt = registeredAt + library.document.retention_days * 86400000;
    const digest = facesJpeg(input.jpeg_base64), space = await this.space(input.model);
    const template = await this.runtime.enroll({ request_id: input.request_id, actor, library_id: id, member_id: memberId, model: input.model, space_id: space,
      jpeg_base64: input.jpeg_base64, jpeg_sha256: digest, retention_days: library.document.retention_days, expires_at: new Date(expiresAt).toISOString(), deadline_ms: this.now() + 30000 });
    if (template.actor !== actor || template.library_id !== id || template.member_id !== memberId || template.request_id !== input.request_id || template.model !== input.model || template.space_id !== space || template.jpeg_sha256 !== digest || template.quality.state !== 'qualified' || Date.parse(template.expires_at) > expiresAt) throw invalid();
    if (Date.parse(template.expires_at) <= this.now()) throw expired();
    // Do not attach automatically: the operator explicitly saves the receipt
    // with the library CAS. A failed save leaves a bounded expiring Mongo ref.
    return publicTemplate(template);
  }
  private async checkPage<T extends FacesPage>(page: T, scope: SearchScope, model: FacesModel, space: string | null, limit: number, actor: string): Promise<T> {
    const allowed = await this.authorize(scope.channel_ids, actor);
    if (!sameSearchScope(page.scope, scope) || page.model !== model || page.space_id !== space || page.items.length > limit || new Set(page.items.map(item => item.id)).size !== page.items.length) throw invalid();
    for (const row of page.items) {
      if (!scope.channel_ids.includes(row.channel_id) || row.model !== model || (space !== null && row.space_id !== space) || Date.parse(row.captured_at) < Date.parse(scope.from) || Date.parse(row.captured_at) >= Date.parse(scope.to) || Date.parse(row.expires_at) <= this.now() || (row.recording_channel_id && !allowed.has(row.recording_channel_id))) throw invalid();
    }
    return page;
  }
  async history(raw: unknown, actor: string) {
    const input = facesHistoryQuerySchema.parse(raw); await this.authorize(input.scope.channel_ids, actor);
    if (input.space_id && !(await this.runtime.status()).spaces.some(space => space.model === input.model && space.space_id === input.space_id))
      throw new FacesError('faces_space_missing', '所选历史模型空间不存在', 422);
    const page = await this.checkPage(await this.runtime.history({ ...input, actor }), input.scope, input.model, input.space_id ?? null, input.limit, actor);
    return { ...page, items: [...page.items].sort((a, b) => Date.parse(b.captured_at) - Date.parse(a.captured_at) || a.id.localeCompare(b.id)) };
  }
  async search(raw: unknown, actor: string) {
    const input = facesSearchQuerySchema.parse(raw); await this.authorize(input.scope.channel_ids, actor);
    const digest = facesJpeg(input.jpeg_base64), space = await this.space(input.model);
    const page = await this.checkPage(await this.runtime.search({ ...input, actor, space_id: space, jpeg_sha256: digest, deadline_ms: this.now() + 30000 }), input.scope, input.model, space, input.limit, actor);
    if (page.query_id !== input.request_id || page.next_cursor !== null || page.quality.state !== 'qualified' || page.items.some(row => row.similarity === undefined || row.quality.state !== 'qualified')) throw invalid();
    return { ...page, items: [...page.items].sort((a, b) => b.similarity! - a.similarity! || a.id.localeCompare(b.id)) };
  }
  cancel(requestId: string, actor: string) { facesId.parse(requestId); return this.runtime.cancel({ request_id: requestId, actor }); }
  async record(id: string, actor: string): Promise<FacesRecord> {
    facesId.parse(id);
    const allowed = (await this.channels(actor)).map(channel => channel.id);
    const row = await this.runtime.record({ id, actor, channel_ids: allowed });
    if (row.id !== id || !allowed.includes(row.channel_id) || (row.recording_channel_id && !allowed.includes(row.recording_channel_id))) throw new FacesError('faces_scope_denied', '当前记录已不可访问', 403);
    if (Date.parse(row.expires_at) <= this.now()) throw expired();
    return row;
  }
  async recordImage(id: string, actor: string) {
    const row = await this.record(id, actor);
    if (!row.photo_ref) throw expired();
    return this.runtime.image({ actor, record_id: id, photo_ref: row.photo_ref });
  }
  async memberImage(id: string, memberId: string, actor: string) {
    facesId.parse(memberId); const library = await this.config().get(id);
    await this.authorize(library.document.channel_ids, actor);
    const template = library.templates[memberId];
    if (!template || Date.parse(template.expires_at) <= this.now() || Date.parse(library.document.valid_until) <= this.now()) throw expired();
    return this.runtime.image({ actor, template_id: template.template_id, photo_ref: template.photo_ref });
  }
  private async historicalReference(id: string, version: number, memberId: string, recordId: string, actor: string) {
    facesId.parse(id); facesVersion.parse(version); facesId.parse(memberId); facesId.parse(recordId);
    if (actor !== 'console-administrator') throw new FacesError('faces_management_required', '历史人脸证据需要已登录的控制台管理会话', 403);
    const channelIds = (await this.channels(actor)).map(channel => channel.id);
    const candidate = await this.runtime.referenceCandidate({ actor, record_id: recordId, library_id: id, library_version: version, member_id: memberId, channel_ids: channelIds });
    if (candidate.record_id !== recordId || candidate.library_id !== id || candidate.library_version !== version || candidate.member_id !== memberId)
      throw new FacesError('faces_reference_mismatch', '历史候选事实与请求版本不一致', 409);
    if (!channelIds.includes(candidate.channel_id) || (candidate.recording_channel_id && !channelIds.includes(candidate.recording_channel_id)))
      throw new FacesError('faces_scope_denied', '历史候选通道已不可访问', 403);
    const library = await this.config().getVersion(id, version);
    await this.authorize(library.document.channel_ids, actor);
    const member = library.document.members.find(value => value.id === memberId), template = library.templates[memberId];
    if (library.id !== id || library.version !== version || !library.document.channel_ids.includes(candidate.channel_id) || !member || !template || member.template_id !== template.template_id || template.library_id !== id || template.member_id !== memberId || template.actor !== actor || template.model !== candidate.model || template.space_id !== candidate.space_id)
      throw new FacesError('faces_reference_mismatch', '历史成员模板与候选事实不一致', 409);
    // Business validity controls matching, not evidence retention. Both independent
    // retention fences still apply; deleted/current configuration is not consulted.
    if (!Number.isFinite(Date.parse(template.expires_at)) || Date.parse(template.expires_at) <= this.now() || Date.parse(library.retain_until) <= this.now()) throw expired();
    const metadata = facesReferenceSchema.parse({ library_id: id, library_version: version, member_id: memberId,
      library_name: library.document.name, member_name: member.name, template_id: template.template_id, photo_ref: template.photo_ref,
      model: template.model, space_id: template.space_id, expires_at: template.expires_at,
      record_id: recordId, event_id: candidate.event_id, occurred_at: candidate.occurred_at });
    return { metadata, template, retainUntil: library.retain_until };
  }
  async memberReference(id: string, version: number, memberId: string, recordId: string, actor: string) {
    return (await this.historicalReference(id, version, memberId, recordId, actor)).metadata;
  }
  async historicalMemberImage(id: string, version: number, memberId: string, recordId: string, actor: string) {
    const { template, retainUntil } = await this.historicalReference(id, version, memberId, recordId, actor);
    const bytes = await this.runtime.image({ actor, template_id: template.template_id, photo_ref: template.photo_ref });
    if (Date.parse(template.expires_at) <= this.now() || Date.parse(retainUntil) <= this.now()) throw expired();
    if (createHash('sha256').update(bytes).digest('hex') !== template.jpeg_sha256)
      throw new FacesError('faces_photo_integrity', '历史参考照片与版本记录的哈希不一致', 409);
    return bytes;
  }
}
