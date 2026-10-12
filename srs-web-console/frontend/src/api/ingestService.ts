import { request } from './httpClient'

export interface IngestCapability {
  enabled: boolean
  codecs: string[]
  mode: string
  reason?: string
  security?: string
}
export type IngestCapabilities = Record<'rtmp' | 'srt' | 'webrtc' | 'rtsp', IngestCapability>
export const ingestService = {
  async capabilities(signal?: AbortSignal) {
    return (await request<{ data: IngestCapabilities }>('/ingest/capabilities', { signal })).data
  },
  async credential(id: string) {
    return (await request<{ data: { token: string; authorization: string } }>(`/channels/${id}/publish-credential`, { method: 'POST' })).data
  },
  async revoke(id: string) {
    await request(`/channels/${id}/publish-credential`, { method: 'DELETE' })
  },
}
