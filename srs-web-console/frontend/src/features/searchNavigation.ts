import type { SearchScope } from '@/api/searchService'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
/** Explicit evidence output only; never infer an AI output from an input camera. */
export function smartSearchHref(channel: string | null | undefined, from: number, to: number) {
  if (!channel || !uuid.test(channel) || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to > 8640000000000000 || to <= from || to - from > 31 * 86400000) return null
  return `/smart-search?${new URLSearchParams({ channel, from: String(from), to: String(to) })}`
}
export function searchEntryScope(params: URLSearchParams): SearchScope | null {
  const channel = params.get('channel'), rawFrom = params.get('from'), rawTo = params.get('to')
  if (!rawFrom || !rawTo || !/^\d{1,16}$/.test(rawFrom) || !/^\d{1,16}$/.test(rawTo)) return null
  const from = Number(rawFrom), to = Number(rawTo)
  if (!smartSearchHref(channel, from, to)) return null
  return { channel_ids: [channel!], from: new Date(from).toISOString(), to: new Date(to).toISOString() }
}
