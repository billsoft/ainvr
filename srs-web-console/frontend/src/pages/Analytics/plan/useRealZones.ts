import { useEffect, useState } from 'react'
import { aiChannelService } from '@/api/aiChannelService'
import { alarmArmingService } from '@/api/alarmArmingService'
import { alarmTriggerService } from '@/api/alarmTriggerService'
import { flowService, type Counter, type CounterResult } from '@/api/flowService'
import { zoneKey, type ZoneInfo } from './planModel'

export interface ZoneCount { in: number; out: number }
export interface RealZones { zones: ZoneInfo[]; counters: { id: string; name: string }[]; counts: Record<string, ZoneCount> }
/** 布防文档里的一个热区，以及它属于哪个处理器（AI 通道）。 */
export interface ZoneSource { zone_id: string; name: string; processor_id: string }

/**
 * 把布防里的热区、计数器的选用和流量统计结果拼成统计页要用的形状；纯函数，方便单测。
 * 计数器正在使用的热区一定会列出：布防文档暂时读不到时，用计数器选用里带的 zone_id 和名称兜底，
 * 不会让一个有计数的热区在列表里消失。
 */
export function assembleZones(sources: ZoneSource[], counters: Counter[], results: CounterResult[] | null): RealZones {
  const live = new Map<string, { name: string; processor: string }>()
  for (const z of sources) if (!live.has(z.zone_id)) live.set(z.zone_id, { name: z.name, processor: z.processor_id })
  for (const c of counters) for (const b of c.bindings) if (b.active && !live.has(b.zone_id)) live.set(b.zone_id, { name: b.zone_name || '热区', processor: b.processor_id })
  const zones: ZoneInfo[] = [...live.entries()].map(([id, z]) => ({
    key: zoneKey(id), channelId: z.processor, zoneId: id, name: z.name,
    counters: counters.filter(c => c.bindings.some(b => b.active && b.zone_id === id)).map(c => ({ id: c.counter_id, name: c.name })),
  }))
  const counts: Record<string, ZoneCount> = {}
  for (const r of results ?? []) for (const z of r.zones) {
    if (!live.has(z.zone_id)) continue
    const c = counts[zoneKey(z.zone_id)] ??= { in: 0, out: 0 }
    c.in += z.in?.occurrences ?? 0; c.out += z.out?.occurrences ?? 0
  }
  return { zones, counters: counters.map(c => ({ id: c.counter_id, name: c.name })), counts }
}

interface State extends RealZones { loading: boolean; error: string; countsFailed: boolean }
/** 读取真实的热区、计数器和所选时段的计数；某个通道的布防读不到时仍显示其余的，并说明。 */
export function useRealZones(range: { from: Date; to: Date }, revision: number): State {
  const [state, setState] = useState<State>({ zones: [], counters: [], counts: {}, loading: true, error: '', countsFailed: false })
  useEffect(() => {
    let alive = true
    setState(s => ({ ...s, loading: true, error: '' }))
    void (async () => {
      try {
        const [channels, counters] = await Promise.all([aiChannelService.list(), flowService.list().then(r => r.items)])
        // 热区画在“来源 + 处理器”的布防文档里：先取处理器当前的来源，再读它的布防。
        const docs = await Promise.allSettled(channels.map(async c => {
          const source = await alarmTriggerService.source(c.id)
          const { arming } = await alarmArmingService.read(source.input_stream_id, c.id)
          return (arming?.zones ?? []).map(z => ({ zone_id: z.zone_id, name: z.name, processor_id: c.id }))
        }))
        const sources = docs.flatMap(d => d.status === 'fulfilled' ? d.value : [])
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
        const results = await flowService.query({ from: range.from.toISOString(), to: range.to.toISOString(), bucket: null, timezone }).then(r => r.items).catch(() => null)
        if (alive) setState({ ...assembleZones(sources, counters, results), loading: false, error: docs.some(d => d.status === 'rejected') ? '部分通道的布防没有读到，已用计数器里记录的热区补上' : '', countsFailed: results === null })
      } catch (e) { if (alive) setState(s => ({ ...s, loading: false, error: e instanceof Error ? e.message : '热区读取失败' })) }
    })()
    return () => { alive = false }
  }, [range.from.getTime(), range.to.getTime(), revision]) // eslint-disable-line react-hooks/exhaustive-deps
  return state
}
