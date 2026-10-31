/**
 * 平面图草稿的数据模型和纯函数。
 * 一份草稿可以有多张平面图；热区和平面图是多对多：每张平面图自己记录“放了哪些热区、放在哪”，
 * 同一个热区可以出现在几张平面图上，一张平面图也可以放很多热区。
 * 平面图上存的只是摆放（位置、大小），用于展示和统计着色；
 * 热区的检测形状在摄像头画面坐标里，仍然只在布防中修改，这里不碰。
 */
export const PLAN_W = 1600
export const PLAN_H = 900
export const MAX_PLANS = 20
const MIN_W = 40, MIN_H = 30, MAX_IMAGE_CHARS = 2_500_000, MAX_TOTAL_IMAGE_CHARS = 4_500_000

export interface ZoneInfo { key: string; channelId: string; zoneId: string; name: string; counters: { id: string; name: string }[] }
export interface Placement { x: number; y: number; w: number; h: number }
export type PlanShape =
  | { id: string; kind: 'room'; x: number; y: number; w: number; h: number; name: string }
  | { id: string; kind: 'line'; points: [number, number, number, number] }
  | { id: string; kind: 'label'; x: number; y: number; text: string }
type Distribute<T> = T extends { id: string } ? Omit<T, 'id'> : never
export type NewShape = Distribute<PlanShape>
export interface Plan { id: string; name: string; image: { data: string; w: number; h: number } | null; shapes: PlanShape[]; placements: Record<string, Placement> }
export interface PlanDraft { version: 2; plans: Plan[]; activeId: string | null }

/** Viewer fits the centered background and all planned content without changing stored coordinates. */
export function planViewport(plan: Plan | null, readOnly = false): Placement {
  if (!readOnly || !plan) return { x: 0, y: 0, w: PLAN_W, h: PLAN_H }
  if(!plan.image){
    // With no background, fit the actual planned content instead of reserving
    // an empty 1600x900 board. Editing coordinates remain unchanged.
    const boxes:Placement[]=Object.values(plan.placements).map(p=>({x:p.x-p.w*.65,y:p.y-p.h*.65,w:p.w*2.3,h:p.h*2.3}))
    for(const s of plan.shapes){
      if(s.kind==='room')boxes.push({x:s.x-4,y:s.y-4,w:s.w+8,h:s.h+8})
      else if(s.kind==='line')boxes.push({x:Math.min(s.points[0],s.points[2])-4,y:Math.min(s.points[1],s.points[3])-4,w:Math.abs(s.points[2]-s.points[0])+8,h:Math.abs(s.points[3]-s.points[1])+8})
      else boxes.push({x:s.x,y:s.y,w:s.text.length*26,h:32})
    }
    if(!boxes.length)return {x:0,y:0,w:PLAN_W,h:PLAN_H}
    const x=Math.min(...boxes.map(p=>p.x)),y=Math.min(...boxes.map(p=>p.y)),right=Math.max(...boxes.map(p=>p.x+p.w)),bottom=Math.max(...boxes.map(p=>p.y+p.h))
    const w=Math.max(400,right-x+40),h=Math.max(225,bottom-y+40)
    return {x:(x+right-w)/2,y:(y+bottom-h)/2,w,h}
  }
  const fit = Math.min(PLAN_W / plan.image.w, PLAN_H / plan.image.h)
  const cx = PLAN_W / 2, cy = PLAN_H / 2
  let hw = plan.image.w * fit / 2, hh = plan.image.h * fit / 2
  const include = (x: number, y: number, right: number, bottom: number) => {
    hw = Math.max(hw, Math.abs(x - cx), Math.abs(right - cx))
    hh = Math.max(hh, Math.abs(y - cy), Math.abs(bottom - cy))
  }
  for (const p of Object.values(plan.placements)) {
    // Preserve the visible tails of the independent count heat field as well as the frame.
    include(p.x - p.w * .65, p.y - p.h * .65, p.x + p.w * 1.65, p.y + p.h * 1.65)
  }
  for (const s of plan.shapes) {
    if (s.kind === 'room') include(s.x - 4, s.y - 4, s.x + s.w + 4, s.y + s.h + 4)
    else if (s.kind === 'line') include(Math.min(s.points[0], s.points[2]) - 4, Math.min(s.points[1], s.points[3]) - 4, Math.max(s.points[0], s.points[2]) + 4, Math.max(s.points[1], s.points[3]) + 4)
    else include(s.x, s.y, s.x + s.text.length * 26, s.y + 32)
  }
  return { x: cx - hw, y: cy - hh, w: hw * 2, h: hh * 2 }
}

export const emptyDraft = (): PlanDraft => ({ version: 2, plans: [], activeId: null })
/** 热区的唯一标识就是布防里的 zone_id，计数器的选用也按它引用。 */
export const zoneKey = (zoneId: string) => zoneId

let counter = 0
const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

// ---------- 左侧列表 ----------
export interface CounterGroup { id: string | null; name: string; zones: ZoneInfo[] }
/** 每个计数器列出它选用的热区；一个热区选了几个计数器就出现在几处；没选任何计数器的热区归到最后一组。 */
export function groupByCounter(zones: ZoneInfo[], counters: { id: string; name: string }[]): CounterGroup[] {
  const groups: CounterGroup[] = counters.map(c => ({ id: c.id, name: c.name, zones: zones.filter(z => z.counters.some(k => k.id === c.id)) }))
  const loose = zones.filter(z => !z.counters.length)
  return loose.length ? [...groups, { id: null, name: '未关联计数器', zones: loose }] : groups
}

// ---------- 摆放 ----------
export const clampPlacement = (p: Placement): Placement => {
  const w = Math.min(PLAN_W, Math.max(MIN_W, p.w)), h = Math.min(PLAN_H, Math.max(MIN_H, p.h))
  return { x: Math.min(PLAN_W - w, Math.max(0, p.x)), y: Math.min(PLAN_H - h, Math.max(0, p.y)), w, h }
}
export const movePlacement = (p: Placement, dx: number, dy: number) => clampPlacement({ ...p, x: p.x + dx, y: p.y + dy })
export const resizePlacement = (p: Placement, w: number, h: number) => clampPlacement({ ...p, w: Math.min(w, PLAN_W - p.x), h: Math.min(h, PLAN_H - p.y) })

/** 把 total 个热区排成网格，第 index 个的位置；保证都在平面图内且互不重叠。 */
export function gridPlacement(index: number, total: number): Placement {
  const pad = 40, n = Math.max(1, total), cols = Math.max(1, Math.ceil(Math.sqrt(n * PLAN_W / PLAN_H))), rows = Math.max(1, Math.ceil(n / cols))
  const cellW = (PLAN_W - pad * 2) / cols, cellH = (PLAN_H - pad * 2) / rows
  const w = Math.min(220, cellW - 16), h = Math.min(120, cellH - 16)
  return { x: Math.round(pad + (index % cols) * cellW + (cellW - w) / 2), y: Math.round(pad + Math.floor(index / cols) * cellH + (cellH - h) / 2), w: Math.round(w), h: Math.round(h) }
}

// ---------- 平面图集合 ----------
export const activePlan = (draft: PlanDraft): Plan | null => draft.plans.find(p => p.id === draft.activeId) ?? draft.plans[0] ?? null
export const isPlaced = (plan: Plan | null, key: string) => !!plan && Object.hasOwn(plan.placements, key)
/** 这个热区出现在哪几张平面图上（多对多）。 */
export const plansOfZone = (draft: PlanDraft, key: string) => draft.plans.filter(p => isPlaced(p, key))

export function addPlan(draft: PlanDraft, name: string, zonesToPlace: ZoneInfo[] = []): PlanDraft {
  if (draft.plans.length >= MAX_PLANS) return draft
  const plan: Plan = { id: newId('p'), name: name.trim() || `平面图 ${draft.plans.length + 1}`, image: null, shapes: [],
    placements: Object.fromEntries(zonesToPlace.map((z, i) => [z.key, gridPlacement(i, zonesToPlace.length)])) }
  return { ...draft, plans: [...draft.plans, plan], activeId: plan.id }
}
export function removePlan(draft: PlanDraft, id: string): PlanDraft {
  const plans = draft.plans.filter(p => p.id !== id)
  return { ...draft, plans, activeId: draft.activeId === id ? plans[0]?.id ?? null : draft.activeId }
}
export const setActive = (draft: PlanDraft, id: string): PlanDraft => draft.plans.some(p => p.id === id) ? { ...draft, activeId: id } : draft
/** 对当前平面图做一次修改；没有平面图时什么也不做。 */
export function updateActive(draft: PlanDraft, change: (plan: Plan) => Plan): PlanDraft {
  const current = activePlan(draft)
  return current ? { ...draft, activeId: current.id, plans: draft.plans.map(p => p.id === current.id ? change(p) : p) } : draft
}

// ---------- 单张平面图上的修改 ----------
export const renamePlan = (plan: Plan, name: string): Plan => ({ ...plan, name: name.trim() || plan.name })
export const setImage = (plan: Plan, image: Plan['image']): Plan => ({ ...plan, image })
export const setPlacement = (plan: Plan, key: string, p: Placement): Plan => ({ ...plan, placements: { ...plan.placements, [key]: clampPlacement(p) } })
/** 把热区放进这张平面图（已经在就不动），放在网格里第一个还没被占用的位置。 */
export function placeZone(plan: Plan, zones: ZoneInfo[], key: string): Plan {
  if (isPlaced(plan, key)) return plan
  const total = Math.max(zones.length, Object.keys(plan.placements).length + 1), used = Object.values(plan.placements)
  const free = Array.from({ length: total }, (_, i) => gridPlacement(i, total)).find(c => !used.some(u => u.x < c.x + c.w && c.x < u.x + u.w && u.y < c.y + c.h && c.y < u.y + u.h)) ?? gridPlacement(0, total)
  return setPlacement(plan, key, free)
}
/** 放入所有还没在这张平面图上的热区。 */
export const placeAll = (plan: Plan, zones: ZoneInfo[]): Plan => zones.reduce((p, z) => placeZone(p, zones, z.key), plan)
/** 只是从这张平面图上拿掉摆放，热区本身和别的平面图上的摆放都不受影响。 */
export function unplaceZone(plan: Plan, key: string): Plan {
  const { [key]: _gone, ...rest } = plan.placements
  return { ...plan, placements: rest }
}
export function addShape(plan: Plan, shape: NewShape): Plan { return { ...plan, shapes: [...plan.shapes, { ...shape, id: newId('s') } as PlanShape] } }
export function updateShape(plan: Plan, id: string, patch: Partial<NewShape>): Plan {
  return { ...plan, shapes: plan.shapes.map(s => s.id === id ? { ...s, ...patch } as PlanShape : s) }
}
export const removeShape = (plan: Plan, id: string): Plan => ({ ...plan, shapes: plan.shapes.filter(s => s.id !== id) })

// ---------- 草稿读写格式 ----------
const num = (v: unknown, lo = -1e5, hi = 1e5): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi
const str = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length <= max
function validShape(s: unknown): s is PlanShape {
  const o = s as Record<string, unknown> | null
  if (!o || typeof o !== 'object' || !str(o.id, 64)) return false
  if (o.kind === 'room') return num(o.x) && num(o.y) && num(o.w, 1) && num(o.h, 1) && str(o.name)
  if (o.kind === 'line') return Array.isArray(o.points) && o.points.length === 4 && o.points.every(v => num(v))
  return o.kind === 'label' && num(o.x) && num(o.y) && str(o.text)
}
function validPlan(p: unknown): p is Plan {
  const o = p as Record<string, unknown> | null
  if (!o || typeof o !== 'object' || !str(o.id, 64) || !str(o.name, 80) || !Array.isArray(o.shapes) || !o.shapes.every(validShape) || !o.placements || typeof o.placements !== 'object') return false
  const image = o.image as Record<string, unknown> | null
  if (image !== null && !(typeof image === 'object' && str(image.data, MAX_IMAGE_CHARS) && (image.data as string).startsWith('data:image/') && num(image.w, 1, 16384) && num(image.h, 1, 16384))) return false
  return Object.values(o.placements as Record<string, Record<string, unknown>>).every(q => q && num(q.x) && num(q.y) && num(q.w, 1) && num(q.h, 1))
}
/** 解析本机保存的草稿；格式不对、版本不符或图片过大一律当作没有，不猜测修复。 */
export function parseDraft(text: string): PlanDraft | null {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return null }
  const o = raw as Record<string, unknown> | null
  if (!o || typeof o !== 'object' || o.version !== 2 || !Array.isArray(o.plans) || o.plans.length > MAX_PLANS || !o.plans.every(validPlan)) return null
  const plans = o.plans as Plan[]
  if (new Set(plans.map(p => p.id)).size !== plans.length) return null
  if (plans.reduce((n, p) => n + (p.image?.data.length ?? 0), 0) > MAX_TOTAL_IMAGE_CHARS) return null
  const activeId = typeof o.activeId === 'string' && plans.some(p => p.id === o.activeId) ? o.activeId : plans[0]?.id ?? null
  return { version: 2, plans, activeId }
}

// ---------- 热度 ----------
/**
 * 把各热区的计数叠成平滑的热度场（cols × rows，0–1）：每个热区在自己摆放的位置上出一个峰，
 * 高度与计数成正比，再整体归一。没有计数的热区、不在这张平面图上的热区都不产生热度；
 * 同一个热区在不同平面图上各自出现在自己的位置。
 */
export function heatCells(plan: Plan, values: Record<string, number>, cols = 32, rows = 18): number[][] {
  const hot = Object.entries(plan.placements).filter(([key]) => (values[key] ?? 0) > 0)
  const top = Math.max(0, ...hot.map(([key]) => values[key]!))
  const grid = Array.from({ length: rows }, (_, y) => Array.from({ length: cols }, (_, x) => {
    const px = (x + .5) / cols * PLAN_W, py = (y + .5) / rows * PLAN_H
    return hot.reduce((n, [key, p]) => {
      const sx = p.w / 2.2, sy = p.h / 2.2
      return n + values[key]! / top * Math.exp(-(((px - (p.x + p.w / 2)) / sx) ** 2 + ((py - (p.y + p.h / 2)) / sy) ** 2) / 2)
    }, 0)
  }))
  const max = Math.max(0, ...grid.flat())
  return max > 0 ? grid.map(r => r.map(v => v / max)) : grid
}

// Per-binding facts stay separate even when counters share a physical zone.
export interface MapCounter {
  id: string
  name: string
  names?: { in: string; out: string }
  outputs?: 'both' | 'in'
  unit?: string
}
export interface MapReading {
  counterId: string
  bindingId: string
  zoneKey: string
  in: number | null
  out: number | null
}
/** Ambiguous multiple locations on one zone are not silently summed for a map label. */
export function mapValuesForCounter(readings: MapReading[], counterId: string, direction: 'in' | 'out'): Record<string, number> {
  const groups = new Map<string, MapReading[]>()
  for (const r of readings) if (r.counterId === counterId) groups.set(r.zoneKey, [...(groups.get(r.zoneKey) ?? []), r])
  const values: Record<string, number> = {}
  for (const [key, rows] of groups) {
    const value = rows[0]?.[direction]
    if (rows.length === 1 && typeof value === 'number' && Number.isFinite(value)) values[key] = value
  }
  return values
}
/** Missing lookup data never removes stored display geometry. */
export function unresolvedPlacementKeys(plan: Plan | null, zones: ZoneInfo[]): string[] {
  const known = new Set(zones.map(z => z.key))
  return Object.keys(plan?.placements ?? {}).filter(key => !known.has(key))
}
