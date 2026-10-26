import { request } from './httpClient'

export interface StorageVolume {
  id: string; device: string; label: string; transport: string; filesystem: string
  mountPath: string; system: boolean; readOnly: boolean; totalBytes: number
  availableBytes: number | null; selectable: boolean; state: string
}
export const storageService = {
  volumes: () => request<{ volumes: StorageVolume[]; sampledAt: number }>('/storage/volumes', { signal: AbortSignal.timeout(12000) }),
  directories: (volume: string, path: string) => request<{ directories: string[]; truncated: boolean }>(`/storage/directories?volume=${encodeURIComponent(volume)}&path=${encodeURIComponent(path)}`, { signal: AbortSignal.timeout(12000) }),
}
export function storageBytes(n: number | null) { return n === null ? '未知' : `${(n / 1024 ** 3).toFixed(1)} GB` }
