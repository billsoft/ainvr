/** Browser-only UI fixture. No production APIs, credentials, recordings or AI. */
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import SearchPage from '@/pages/Search'
import { searchService, type SearchPageResult } from '@/api/searchService'
import '@/styles/globals.css'
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const channels = Array.from({ length: 12 }, (_, n) => ({ id: uid(n + 1), name: `${['登船口', '码头入口', '设备区'][n % 3]} ${n + 1}` }))
let mode = 'ready', last: SearchPageResult | null = null
const actualFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!url.startsWith('/api/search/')) return actualFetch(input, init)
  if (mode === 'missing') return new Response('', { status: 404 })
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#243448"/><path d="M0 470L400 170H600L960 470" fill="#425772"/><rect x="400" y="80" width="240" height="420" fill="none" stroke="#40d9a0" stroke-width="4"/><circle cx="520" cy="160" r="35" fill="#d7e5f2"/><path d="M475 215H565L600 350H440Z" fill="#3986e8"/><path d="M480 350L470 460M555 350L565 460" stroke="#d7e5f2" stroke-width="24"/><text x="24" y="44" font-family="sans-serif" font-size="25" fill="white">隔离测试示意图 · 非真实录像或模型结果</text></svg>`
  return new Response(new Blob([svg], { type: 'image/svg+xml' }), { status: 200 })
}
searchService.status = async () => {
  if (mode === 'failure') throw Error('隔离测试：服务连接失败')
  return { ready: mode !== 'pending', reason: mode === 'pending' ? 'model_pending' : null, model_version: 'fixture-only' }
}
searchService.channels = async () => ({ items: structuredClone(channels) })
searchService.query = async input => {
  const selected = input.scope.channel_ids.map(id => channels.find(channel => channel.id === id))
  if (!selected.length || selected.some(channel => !channel)) throw Error('隔离测试：所选来源不存在')
  last = { search_id: input.request_id, scope: input.scope, model_version: 'fixture-only', coverage: 'partial', next_cursor: null,
    items: Array.from({ length: 6 }, (_, n) => {
      const source = selected[n % selected.length]!
      return { id: uid(100 + n), channel_id: source.id, channel_name: source.name,
      source_input_id: uid(1000 + channels.findIndex(channel => channel.id === source.id)), processor_id: `fixture-processor-${source.id}`, output_channel_id: source.id, kind: n % 2 ? 'scene' : 'object',
      started_at: new Date(Date.parse(input.scope.to) - (n + 1) * 60000).toISOString(), ended_at: new Date(Date.parse(input.scope.to) - (n + 1) * 60000 + 3000).toISOString(),
      frames: [0, 1, 2].map(i => ({ id: uid(200 + n * 10 + i), captured_at: new Date(Date.parse(input.scope.to) - (n + 1) * 60000 + i * 1000).toISOString(), role: i === 0 ? 'before' : i === 1 ? 'match' : 'after' })),
      recording: { channel_id: source.id, state: n === 1 ? 'missing' : 'available' }, verification: { state: n === 2 ? 'uncertain' : 'candidate' }, feedback: null }
    }) }
  return structuredClone(last)
}
searchService.page = async () => structuredClone(last!)
searchService.feedback = async (_id, result, relevant) => { if (last) last.items.find(i => i.id === result)!.feedback = relevant ? 'relevant' : 'irrelevant'; return { relevant } }
searchService.cancel = async () => ({ cancelled: true })
function Fixture() {
  const [width, setWidth] = useState('100%'), [revision, setRevision] = useState(0)
  return <><header className="flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 p-3 text-sm"><strong>智能搜索隔离验收</strong><span>测试示意数据，不连接生产相机或模型</span>
    <select aria-label="验收宽度" className="min-h-11 border px-2" value={width} onChange={e => setWidth(e.target.value)}><option value="100%">桌面</option><option value="768px">平板</option><option value="390px">窄屏</option></select>
    <select aria-label="模拟状态" className="min-h-11 border px-2" onChange={e => { mode = e.target.value; setRevision(r => r + 1) }}><option value="ready">服务就绪</option><option value="pending">模型待就绪</option><option value="missing">证据图片缺失</option><option value="failure">服务故障</option></select>
    </header><main style={{ width, maxWidth: '100%', margin: 'auto' }}><MemoryRouter key={revision}><SearchPage /></MemoryRouter></main></>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
