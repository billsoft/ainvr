import { request, requestBlob } from './httpClient'
export type FaceModel = 'mbf' | 'r50'
export interface FaceScope { channel_ids: string[]; from: string; to: string }
export interface FaceMember { id: string; name: string; note: string; template_id: string | null }
export interface FaceLibraryDocument { name: string; model: FaceModel; channel_ids: string[]; valid_until: string; retention_days: number; match_requested: boolean; match_threshold: number | null; access: 'console-management'; members: FaceMember[] }
export interface FaceTemplate { template_id: string; photo_ref: string; model: FaceModel; space_id: string; quality: { state: 'qualified' | 'rejected' | 'unknown'; reason: string | null }; expires_at: string }
export interface FaceLibrary { id: string; version: number; document: FaceLibraryDocument; templates: Record<string, FaceTemplate>; updated_at: string; configuration_state?: 'saved'; effective?: boolean; runtime_note: string }
export interface FaceStatus { diagnostics?: { task: string; state: string; reason: string | null; last_success_at: string | null }[]; active_model?: FaceModel | null; desired_model?: FaceModel | null; ready: boolean; reason: string | null; accuracy_verified: boolean; spaces: { model: FaceModel; space_id: string; dimensions: number; alignment_version: string; metric: 'cosine'; active?: boolean }[] }
export interface FaceRecord { id: string; channel_id: string; processor_id: string; session_id: string; track_id: string; captured_at: string; expires_at: string; model: FaceModel; space_id: string; quality: FaceTemplate['quality']; photo_ref: string | null; match: { state: 'candidate' | 'unmatched' | 'unavailable'; reason: string | null; library_id?: string; library_version?: number; member_id?: string }; similarity?: number; recording_channel_id: string | null }
export interface FacePage { scope: FaceScope; model: FaceModel; space_id: string | null; items: FaceRecord[]; next_cursor: string | null; coverage: 'unknown' | 'partial' | 'sampled'; query_id?: string }
export interface FaceChannel { id: string; name: string }
const root = (id: string) => `/faces/libraries/${encodeURIComponent(id)}`
const bounded = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000)
const send = <T,>(path: string, input: unknown, method = 'POST', key?: string, signal?: AbortSignal) => request<T>(path, { method, body: JSON.stringify(input), signal: bounded(signal), ...(key ? { headers: { 'Idempotency-Key': key } } : {}) })
export const faceService = {
  status: () => request<FaceStatus>('/faces/status', { signal: bounded() }),
  channels: () => request<{ items: FaceChannel[] }>('/faces/channels', { signal: bounded() }),
  libraries: () => request<{ items: FaceLibrary[]; limits: { libraries: number; members: number } }>('/faces/libraries', { signal: bounded() }),
  library: (id: string) => request<FaceLibrary>(root(id), { signal: bounded() }),
  save: (id: string, version: number, document: FaceLibraryDocument, key: string) => send<FaceLibrary>(root(id), { expected_version: version, document }, 'PUT', key),
  delete: (id: string, version: number, key: string) => send<{ deleted: true }>(`${root(id)}/delete`, { expected_version: version }, 'POST', key),
  enroll: (id: string, memberId: string, input: { request_id: string; expected_version: number; model: FaceModel; jpeg_base64: string }) => send<FaceTemplate>(`${root(id)}/members/${encodeURIComponent(memberId)}/photo`, input),
  history: (input: { scope: FaceScope; model: FaceModel; limit: number; space_id?: string; cursor?: string }, signal?: AbortSignal) => send<FacePage>('/faces/history/query', input, 'POST', undefined, signal),
  search: (input: { request_id: string; scope: FaceScope; model: FaceModel; limit: number; jpeg_base64: string }, signal?: AbortSignal) => send<FacePage>('/faces/search', input, 'POST', undefined, signal),
  cancel: (id: string) => send<{ cancelled: true }>(`/faces/search/${encodeURIComponent(id)}/cancel`, {}),
  record: (id: string, signal?: AbortSignal) => request<FaceRecord>(`/faces/records/${encodeURIComponent(id)}`, { signal: bounded(signal) }),
  recordPhoto: (id: string, signal?: AbortSignal) => requestBlob(`/faces/records/${encodeURIComponent(id)}/photo`, bounded(signal)),
  historicalMemberPhoto: (id: string, version: number, member: string, recordId: string, signal?: AbortSignal) => requestBlob(`${root(id)}/versions/${version}/members/${encodeURIComponent(member)}/photo?record_id=${encodeURIComponent(recordId)}`, bounded(signal)),
  memberPhoto: (id: string, member: string, signal?: AbortSignal) => requestBlob(`${root(id)}/members/${encodeURIComponent(member)}/photo`, bounded(signal)),
}
export function faceError(error: unknown) { return error instanceof Error ? error.message : '人脸请求失败，输入已保留，请重试' }
export function readFaceJpeg(file: File): Promise<string> {
  if (file.type !== 'image/jpeg' || !/\.jpe?g$/i.test(file.name) || file.size < 4 || file.size > 4 * 1024 * 1024) return Promise.reject(Error('请选择不超过4MB的JPEG照片'))
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = () => reject(Error('读取照片失败，请重新选择')); reader.readAsDataURL(file) })
}
