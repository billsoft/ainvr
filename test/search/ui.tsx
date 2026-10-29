/** Browser-only UI fixture. No production APIs, credentials, recordings or AI. */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import SearchPage from '@/pages/Search'
import { searchService, type SearchPageResult, type SearchQuery } from '@/api/searchService'
import '@/styles/globals.css'
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const channels = Array.from({ length: new URLSearchParams(window.location.search).get('channels') === '105' ? 105 : 12 }, (_, n) => ({ id: uid(n + 1), name: `${['登船口', '码头入口', '设备区'][n % 3]} ${n + 1}` }))
export const searchUiFixtureModes = ['ready', 'delayed', 'late_cancel', 'page403', 'page410', 'image404', 'pending', 'failure'] as const
type Mode = typeof searchUiFixtureModes[number]
const params = new URLSearchParams(window.location.search)
let mode: Mode = searchUiFixtureModes.includes(params.get('mode') as Mode) ? params.get('mode') as Mode : 'ready'
export function setSearchUiFixtureMode(value: Mode) { mode = value }
type Session = { page: SearchPageResult; created: number; cancelled: boolean }
const sessions = new Map<string, Session>()
const unavailable = (status: number) => Object.assign(new Error(status === 403 ? '隔离测试：摄像头权限已撤销' : '隔离测试：搜索证据已过期'), { status })
const actualFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!url.startsWith('/api/search/')) return actualFetch(input, init)
  if (mode === 'image404') return new Response('', { status: 404 })
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#243448"/><path d="M0 470L400 170H600L960 470" fill="#425772"/><circle cx="520" cy="160" r="35" fill="#d7e5f2"/><path d="M475 215H565L600 350H440Z" fill="#3986e8"/><path d="M480 350L470 460M555 350L565 460" stroke="#d7e5f2" stroke-width="24"/><text x="24" y="44" font-family="sans-serif" font-size="25" fill="white">隔离测试示意图 · 非真实录像或模型结果</text></svg>`
  return new Response(svg, { status: 200, headers: { 'content-type': 'image/svg+xml' } })
}
searchService.status = async () => {
  if (mode === 'failure') throw Error('隔离测试：服务连接失败')
  return { ready: mode !== 'pending', reason: mode === 'pending' ? 'model_pending' : null, model_version: 'fixture-only' }
}
searchService.channels = async () => ({ items: structuredClone(channels) })
searchService.coverage = async scope => ({ scope, state: 'partial', ranges: scope.channel_ids.flatMap(channel_id => (['object', 'scene'] as const).map(kind => ({ channel_id, kind, from: scope.from, to: scope.to, state: 'gap' as const }))) })
function delay(milliseconds: number, signal?: AbortSignal, ignoreAbort = false) {
  return new Promise<void>((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(done, milliseconds)
    function abort() { if (!ignoreAbort) { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new DOMException('Cancelled', 'AbortError')) } }
    if (!ignoreAbort) { if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true }) }
  })
}
function snapshot(id: string, cursor: string | null = null): SearchPageResult {
  if (mode === 'page403') throw unavailable(403)
  if (mode === 'page410') throw unavailable(410)
  const session = sessions.get(id)
  if (!session || session.cancelled) throw unavailable(410)
  if (cursor !== null && cursor !== 'v1.20') throw new Error('隔离测试：未知分页游标')
  const page = structuredClone(session.page), elapsed = Date.now() - session.created
  const finals = ['match', 'mismatch', 'uncertain', 'unavailable', 'match'] as const
  page.items = page.items.slice(cursor ? 20 : 0, cursor ? 26 : 20).map((item, n) => {
    if (!cursor && n < 5) item.verification = elapsed < 4000 ? { state: 'queued', validated: false }
      : elapsed < 8000 ? { state: 'running', validated: false }
      : { state: finals[n]!, validated: false, cached: n === 4, reason: n === 2 ? 'temporal_evidence_required' : n === 3 ? 'model_unavailable' : 'visible_evidence' }
    return item
  })
  page.next_cursor = cursor ? null : 'v1.20'
  return page
}
searchService.query = async (input: SearchQuery, signal?: AbortSignal) => {
  const selected = input.scope.channel_ids.map(id => channels.find(channel => channel.id === id))
  if (!selected.length || selected.some(channel => !channel)) throw Error('隔离测试：所选来源不存在')
  const ownMode = mode
  if (ownMode === 'delayed' || ownMode === 'late_cancel') await delay(8000, signal, ownMode === 'late_cancel')
  else await delay(100, signal)
  const page: SearchPageResult = { search_id: input.request_id, scope: structuredClone(input.scope), model_version: 'fixture-only', coverage: 'partial', next_cursor: 'v1.20',
    items: Array.from({ length: 26 }, (_, n) => {
      const source = selected[n % selected.length]!
      return { id: uid(100 + n), channel_id: source.id, channel_name: source.name,
        source_input_id: uid(1000 + channels.findIndex(channel => channel.id === source.id)), processor_id: `fixture-processor-${source.id}`, output_channel_id: source.id, kind: n % 2 ? 'scene' : 'object',
        started_at: new Date(Date.parse(input.scope.to) - (n + 1) * 60000).toISOString(), ended_at: new Date(Date.parse(input.scope.to) - (n + 1) * 60000 + 3000).toISOString(),
        frames: (n % 2 ? [1] : [0, 1, 2]).map(i => ({ id: uid(200 + n * 10 + i), captured_at: new Date(Date.parse(input.scope.to) - (n + 1) * 60000 + i * 1000).toISOString(), role: i === 0 ? 'before' : i === 1 ? 'match' : 'after', ...(n % 2 ? {} : { bbox: [400 / 960, 80 / 540, 240 / 960, 420 / 540] as [number, number, number, number] }) })),
        recording: { channel_id: source.id, state: n === 1 ? 'missing' : 'available' }, verification: { state: 'candidate' }, feedback: null }
    }) }
  sessions.set(input.request_id, { page, created: Date.now(), cancelled: false })
  while (sessions.size > 8) sessions.delete(sessions.keys().next().value!)
  // Permission/expiry modes apply to subsequent page reads, so the open cards
  // can demonstrate the real component's 4-second permanent-error handling.
  const initial = structuredClone(page); initial.items = initial.items.slice(0, 20)
  initial.items.slice(0, 5).forEach(item => { item.verification = { state: 'queued', validated: false } })
  return initial
}
searchService.page = async (id, cursor) => snapshot(id, cursor)
searchService.feedback = async (id, result, relevant) => {
  const session = sessions.get(id)
  if (!session || session.cancelled || mode === 'page410') throw unavailable(410)
  if (mode === 'page403') throw unavailable(403)
  const item = session.page.items.find(item => item.id === result)
  if (!item) throw unavailable(410)
  item.feedback = relevant ? 'relevant' : 'irrelevant'
  return { relevant }
}
searchService.cancel = async id => { const session = sessions.get(id); if (session) session.cancelled = true; return { cancelled: true } }
const modeLabels: Record<Mode, string> = { ready: '正常 · 20+6页 / 8秒完成参考分析', delayed: '延迟8秒 · 取消中断返回', late_cancel: '延迟8秒 · 取消后仍迟到返回',
  page403: '已加载后权限403', page410: '已加载后过期410', image404: '图片404', pending: '模型未就绪', failure: '服务连接失败' }
function Fixture() {
  const initialWidth = ['768px', '390px'].includes(params.get('width') ?? '') ? params.get('width')! : '100%'
  const [width, setWidth] = useState(initialWidth), [revision, setRevision] = useState(0), [selectedMode, setSelectedMode] = useState(mode)
  return <><header className="flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 p-3 text-sm"><strong>智能搜索隔离验收</strong><span>测试示意数据，不连接生产相机或模型；位置框由夹具坐标驱动，仅验证产品叠加；回放仅验证导航链接，不播放真实录像。</span>
    <label>验收宽度 <select className="min-h-11 border px-2" value={width} onChange={e => setWidth(e.target.value)}><option value="100%">桌面</option><option value="768px">平板</option><option value="390px">窄屏</option></select></label>
    <label>模拟状态 <select className="min-h-11 max-w-full border px-2" value={selectedMode} onChange={e => { const next = e.target.value as Mode; setSearchUiFixtureMode(next); setSelectedMode(next); setRevision(r => r + 1) }}>{searchUiFixtureModes.map(value => <option key={value} value={value}>{modeLabels[value]}</option>)}</select></label>
    <button type="button" className="min-h-11 rounded border px-3" onClick={() => setRevision(r => r + 1)}>重新开始验收</button>
    </header><main style={{ width, maxWidth: '100%', margin: 'auto' }}><MemoryRouter key={revision}><SearchPage /></MemoryRouter></main></>
}
const fixtureRoot = document.getElementById('root')
if (fixtureRoot) createRoot(fixtureRoot).render(<Fixture />)
