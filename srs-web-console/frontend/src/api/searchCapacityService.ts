import { request } from './httpClient'

export interface SearchCapacity {
  samples: number; bytes: number; max_samples: number; max_bytes: number
  retention_days: number; coverage: number; max_coverage: number
  /** Rolling retention: oldest evidence is evicted when the quota is full. Absent on older services. */
  evicted_samples?: number; evicted_bytes?: number; eviction_runs?: number
  rolling_min_age_ms?: number; oldest_retained_captured_ms?: number | null
}
/** Device-wide usage is a configuration-administrator resource. */
export const searchCapacityService = {
  read: (signal?: AbortSignal) => request<SearchCapacity>('/v1/config/search-capacity', {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
  }),
}
