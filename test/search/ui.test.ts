import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { searchService, type SearchQuery } from '@/api/searchService'
const original = { ...searchService }, originalFetch = window.fetch
let setMode: (mode: 'ready' | 'delayed' | 'late_cancel' | 'page403' | 'page410' | 'image404' | 'pending' | 'failure') => void
beforeAll(async () => { setMode = (await import('./ui')).setSearchUiFixtureMode })
beforeEach(() => { vi.useFakeTimers(); setMode('ready') })
afterEach(() => vi.useRealTimers())
afterAll(() => { Object.assign(searchService, original); window.fetch = originalFetch })
async function input(): Promise<SearchQuery> {
  const channel = (await searchService.channels()).items[0]!
  return { request_id: crypto.randomUUID(), query: '测试红色背包', verify: true,
    scope: { channel_ids: [channel.id], from: new Date(Date.now() - 86400000).toISOString(), to: new Date().toISOString() } }
}
async function query() {
  const request = await input(), pending = searchService.query(request)
  await vi.advanceTimersByTimeAsync(100)
  return searchService.query === original.query ? Promise.reject(new Error('Fixture did not install')) : pending
}
it('provides a stable 20+6 candidate scope with object/scene evidence and separate feedback', async () => {
  const first = await query()
  expect(first.items).toHaveLength(20); expect(first.next_cursor).toBe('v1.20')
  expect(new Set(first.items.map(i => i.kind))).toEqual(new Set(['object', 'scene']))
  const last = await searchService.page(first.search_id, first.next_cursor)
  expect(last.items).toHaveLength(6); expect(last.next_cursor).toBeNull()
  expect(new Set([...first.items, ...last.items].map(i => i.id)).size).toBe(26)
  expect(first.items.every(i => i.frames.length === (i.kind === 'scene' ? 1 : 3) && i.recording.channel_id === i.output_channel_id)).toBe(true)
  await searchService.feedback(first.search_id, first.items[0]!.id, true)
  await vi.advanceTimersByTimeAsync(8000)
  const final = await searchService.page(first.search_id, null)
  expect(final.items.slice(0, 5).map(i => i.verification.state)).toEqual(['match', 'mismatch', 'uncertain', 'unavailable', 'match'])
  expect(final.items.slice(0, 5).every(i => i.verification.validated === false)).toBe(true)
  expect(final.items.slice(5).every(i => i.verification.state === 'candidate')).toBe(true)
  expect(final.items[0]!.feedback).toBe('relevant')
  expect(final.items[4]!.verification.cached).toBe(true)
  expect(final.items.map(i => i.id)).toEqual(first.items.map(i => i.id))
})
it('makes the real 4-second polling cadence observable without regenerating candidates', async () => {
  const page = await query()
  expect(page.items[0]!.verification.state).toBe('queued')
  await vi.advanceTimersByTimeAsync(4000)
  expect((await searchService.page(page.search_id, null)).items[0]!.verification.state).toBe('running')
  await vi.advanceTimersByTimeAsync(4000)
  expect((await searchService.page(page.search_id, null)).items[0]!.verification.state).toBe('match')
})
it('honors cancellation in delayed mode and explicitly simulates a late result separately', async () => {
  setMode('delayed')
  const request = await input(), controller = new AbortController()
  const pending = searchService.query(request, controller.signal)
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort(); await searchService.cancel(request.request_id); await rejected
  setMode('late_cancel')
  const next = await input(), old = new AbortController()
  const late = searchService.query(next, old.signal)
  old.abort(); await searchService.cancel(next.request_id)
  await vi.advanceTimersByTimeAsync(8000)
  expect((await late).search_id).toBe(next.request_id)
})
it.each([['page403', 403], ['page410', 410]] as const)('returns initial cards then permanent %s on page/feedback', async (mode, status) => {
  setMode(mode)
  const first = await query()
  expect(first.items).toHaveLength(20)
  await expect(searchService.page(first.search_id, null)).rejects.toMatchObject({ status })
  await expect(searchService.feedback(first.search_id, first.items[0]!.id, true)).rejects.toMatchObject({ status })
})
it('keeps missing images and unavailable service explicit and never contacts production', async () => {
  setMode('image404')
  expect((await window.fetch('/api/search/fixture/results/a/images/b')).status).toBe(404)
  setMode('ready')
  const image = await window.fetch('/api/search/fixture/results/a/images/b')
  expect(image.headers.get('content-type')).toBe('image/svg+xml')
  expect(await image.text()).toContain('非真实录像或模型结果')
  setMode('pending'); expect(await searchService.status()).toMatchObject({ ready: false, reason: 'model_pending' })
  setMode('failure'); await expect(searchService.status()).rejects.toThrow('隔离测试')
})
