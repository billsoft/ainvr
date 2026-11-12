// Fixture-only product prototype. No production API, credentials or real plates.
export type ReadState = '已识别' | '不可读' | '候选冲突' | '未检出车牌' | '处理中'
export type Passage = { id: string; plate: string; original: string; zone: string; channel: string; at: string; direction: '进入' | '离开'; state: ReadState; alarm: boolean; review: '未审核' | '确认' | '误报'; note?: string }
export const zones = ['东门入口', '西门出口', '卸货区']
export const channels = ['东门摄像机', '西门摄像机', '卸货区摄像机']
export const states: ReadState[] = ['已识别', '不可读', '候选冲突', '未检出车牌', '处理中']
export const initialRecords: Passage[] = Array.from({length: 48}, (_, i): Passage => {
  const z = i % 3, state = i % 11 === 0 ? states[1 + i % 4]! : states[0]!
  const plate = state === '已识别' ? ['京A·12345', '沪B·20681', '粤B·D23816', '浙A·50329', '苏E·72103', '京A·32860'][i % 6]! : ''
  return { id: `demo-passage-${i}`, plate, original: plate, zone: zones[z]!, channel: channels[z]!, at: `2026-11-${i < 30 ? '11' : '10'}T${String(8 + i % 9).padStart(2,'0')}:${String(i * 7 % 60).padStart(2,'0')}:00+08:00`, direction: z === 1 ? '离开' : '进入', state, alarm: Boolean(plate && i % 6 === 0), review: i === 12 ? '确认' : '未审核' }
}).sort((a,b) => Date.parse(b.at) - Date.parse(a.at))
export type Scope = { channel: string; zone: string; query: string; state: string; direction: string; from: string; to: string }
export const initialScope: Scope = { channel: '', zone: '', query: '', state: '', direction: '', from: '2026-11-11T00:00:00', to: '2026-11-11T23:59:59' }
export const normalizePlate = (s: string) => s.toUpperCase().replace(/[·\s]/g, '')
export function selectRecords(rows: Passage[], s: Scope) {
  const from = Date.parse(s.from + '+08:00'), to = Date.parse(s.to + '+08:00')
  return rows.filter(r => (!s.channel || r.channel === s.channel) && (!s.zone || r.zone === s.zone) && (!s.state || r.state === s.state) && (!s.direction || r.direction === s.direction) && normalizePlate(r.plate).includes(normalizePlate(s.query)) && Date.parse(r.at) >= from && Date.parse(r.at) <= to)
}
export function metrics(rows: Passage[]) {
  const read = rows.filter(r => r.state === '已识别').length
  return { total: rows.length, read, rate: rows.length ? read / rows.length : null, incoming: rows.filter(r => r.direction === '进入').length, outgoing: rows.filter(r => r.direction === '离开').length, alarms: rows.filter(r=>r.alarm).length }
}
