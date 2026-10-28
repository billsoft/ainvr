import { request } from './httpClient'
export interface SearchStatus {
  ready: boolean
  reason: 'disabled' | 'config_pending' | 'model_pending' | 'service_unavailable' | 'storage_unavailable' | null
  model_version: string | null
}
export interface SearchModelCatalog {
  items: { package_id: string; display_name: string; ready: boolean; reason: string | null; model_version: string | null; dimensions: number | null }[]
  service_ready: boolean
  reason: 'service_unavailable' | null
}
export interface SearchScope { channel_ids: string[]; from: string; to: string }
export interface SearchFrame { id: string; captured_at: string; role: 'match' | 'before' | 'after' | 'context' }
export interface SearchResult {
  id: string; channel_id: string; channel_name: string
  source_input_id: string; processor_id: string | null; output_channel_id: string | null
  kind: 'object' | 'scene'; started_at: string; ended_at: string; frames: SearchFrame[]
  recording: { channel_id: string | null; state: 'available' | 'missing' | 'pending' }
  verification: { state: 'candidate' | 'queued' | 'running' | 'match' | 'mismatch' | 'uncertain' | 'unavailable' }
  feedback: 'relevant' | 'irrelevant' | null
}
export interface SearchPageResult {
  search_id: string; scope: SearchScope; model_version: string
  coverage: 'unknown' | 'partial' | 'sampled'; items: SearchResult[]; next_cursor: string | null
}
export interface SearchQuery { query: string; scope: SearchScope; verify: boolean; request_id: string }
const root = (id: string) => `/search/${encodeURIComponent(id)}`
const item = (id: string, result: string) => `${root(id)}/results/${encodeURIComponent(result)}`
export const searchImagePath = (id: string, result: string, frame: string) => `${item(id, result)}/images/${encodeURIComponent(frame)}`
const bounded = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
export const searchService = {
  models: (signal?: AbortSignal) => request<SearchModelCatalog>('/search/models', { signal: bounded(signal) }),
  status: (signal?: AbortSignal) => request<SearchStatus>('/search/status', { signal: bounded(signal) }),
  channels: (signal?: AbortSignal) => request<{ items: { id: string; name: string }[] }>('/search/channels', { signal: bounded(signal) }),
  query: (input: SearchQuery, signal?: AbortSignal) => request<SearchPageResult>('/search/text', { method: 'POST', body: JSON.stringify(input), signal: bounded(signal) }),
  page: (id: string, cursor: string | null, signal?: AbortSignal) => request<SearchPageResult>(`${root(id)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { signal: bounded(signal) }),
  detail: (id: string, result: string, signal?: AbortSignal) => request<SearchResult>(item(id, result), { signal: bounded(signal) }),
  cancel: (id: string) => request<{ cancelled: boolean }>(`${root(id)}/cancel`, { method: 'POST', signal: bounded() }),
  feedback: (id: string, result: string, relevant: boolean) => request<{ relevant: boolean }>(`${item(id, result)}/feedback`, { method: 'POST', body: JSON.stringify({ relevant }), signal: bounded() }),
}
