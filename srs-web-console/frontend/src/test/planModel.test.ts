import { describe, expect, it } from 'vitest'
import {
  MAX_PLANS, PLAN_H, PLAN_W, activePlan, addPlan, addShape, clampPlacement, emptyDraft, groupByCounter, isPlaced, movePlacement, parseDraft,
  heatCells, placeAll, placeZone, plansOfZone, removePlan, removeShape, renamePlan, resizePlacement, setActive, setImage, setPlacement, unplaceZone,
  updateActive, updateShape, type Plan, type PlanDraft, type ZoneInfo,
} from '@/pages/Analytics/plan/planModel'

const counter = (id: string) => ({ id, name: `计数器${id}` })
const zone = (id: string, counters: string[] = []): ZoneInfo => ({ key: id, channelId: 'ch', zoneId: id, name: `热区${id}`, counters: counters.map(counter) })
const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const first = (d: PlanDraft) => activePlan(d)!

describe('grouping the left list', () => {
  it('lists every counter with its zones, a zone under each counter it uses, and unattached zones last', () => {
    const groups = groupByCounter([zone('z1', ['1']), zone('z2', ['1', '2']), zone('z3')], [counter('1'), counter('2'), counter('3')])
    expect(groups.map(g => g.id)).toEqual(['1', '2', '3', null])
    expect(groups[0]!.zones.map(z => z.zoneId)).toEqual(['z1', 'z2'])
    expect(groups[1]!.zones.map(z => z.zoneId)).toEqual(['z2'])
    expect(groups[2]!.zones).toEqual([])
    expect(groups[3]!.zones.map(z => z.zoneId)).toEqual(['z3'])
  })
  it('has no unattached group when every zone has a counter', () => {
    expect(groupByCounter([zone('z1', ['1'])], [counter('1')]).map(g => g.id)).toEqual(['1'])
  })
})

describe('several plans and zones that belong to several plans', () => {
  const zones = [zone('z1'), zone('z2'), zone('z3')]
  it('starts without plans and makes each new plan the active one', () => {
    const none = emptyDraft()
    expect(activePlan(none)).toBeNull()
    expect(updateActive(none, p => p)).toBe(none)
    const one = addPlan(none, '一层')
    const two = addPlan(one, '  ')
    expect(two.plans.map(p => p.name)).toEqual(['一层', '平面图 2'])
    expect(two.activeId).toBe(two.plans[1]!.id)
    expect(setActive(two, one.plans[0]!.id).activeId).toBe(one.plans[0]!.id)
    expect(setActive(two, 'missing')).toBe(two)
    expect(addPlan(Array.from({ length: MAX_PLANS }).reduce<PlanDraft>(d => addPlan(d, 'x'), emptyDraft()), 'extra').plans).toHaveLength(MAX_PLANS)
  })
  it('lets the same zone sit on several plans with its own place on each', () => {
    let draft = addPlan(addPlan(emptyDraft(), 'A', zones), 'B')
    draft = updateActive(draft, p => placeZone(p, zones, 'z1'))
    const [a, b] = draft.plans as [Plan, Plan]
    expect(isPlaced(a, 'z1')).toBe(true); expect(isPlaced(b, 'z1')).toBe(true)
    expect(isPlaced(b, 'z2')).toBe(false)
    draft = updateActive(draft, p => setPlacement(p, 'z1', { x: 900, y: 500, w: 100, h: 60 }))
    expect(draft.plans[0]!.placements.z1).not.toEqual(draft.plans[1]!.placements.z1)
    expect(plansOfZone(draft, 'z1').map(p => p.name)).toEqual(['A', 'B'])
    expect(plansOfZone(draft, 'z2').map(p => p.name)).toEqual(['A'])
  })
  it('removing a zone from one plan keeps it on the others, and deleting a plan never touches zones', () => {
    let draft = addPlan(addPlan(emptyDraft(), 'A', zones), 'B', zones)
    draft = updateActive(draft, p => unplaceZone(p, 'z1'))
    expect(plansOfZone(draft, 'z1').map(p => p.name)).toEqual(['A'])
    const removed = removePlan(draft, draft.plans[1]!.id)
    expect(removed.plans.map(p => p.name)).toEqual(['A']); expect(removed.activeId).toBe(removed.plans[0]!.id)
    expect(removePlan(removed, removed.plans[0]!.id)).toEqual({ version: 2, plans: [], activeId: null })
  })
  it('places zones on a grid without overlap, each on its own free spot', () => {
    const many = Array.from({ length: 9 }, (_, i) => zone(`m${i}`))
    const plan = first(addPlan(emptyDraft(), 'big', many))
    const rects = many.map(z => plan.placements[z.key]!)
    for (const r of rects) { expect(r.x).toBeGreaterThanOrEqual(0); expect(r.y).toBeGreaterThanOrEqual(0); expect(r.x + r.w).toBeLessThanOrEqual(PLAN_W); expect(r.y + r.h).toBeLessThanOrEqual(PLAN_H) }
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlap(rects[i]!, rects[j]!)).toBe(false)
    const extra = [...many, zone('late')]
    const grown = placeZone(plan, extra, 'late')
    expect(isPlaced(grown, 'late')).toBe(true)
    for (const z of many) expect(overlap(grown.placements.late!, grown.placements[z.key]!)).toBe(false)
    expect(placeZone(grown, extra, 'late')).toBe(grown)
    expect(Object.keys(placeAll(first(addPlan(emptyDraft(), 'p')), extra).placements)).toHaveLength(10)
  })
  it('clamps moving and resizing to the plan and a minimum size', () => {
    const p = { x: 100, y: 100, w: 120, h: 80 }
    expect(movePlacement(p, -500, -500)).toMatchObject({ x: 0, y: 0 })
    expect(movePlacement(p, 5000, 5000)).toMatchObject({ x: PLAN_W - 120, y: PLAN_H - 80 })
    expect(resizePlacement(p, 1, 1)).toMatchObject({ w: 40, h: 30 })
    expect(resizePlacement(p, 99999, 99999)).toMatchObject({ w: PLAN_W - 100, h: PLAN_H - 100 })
    expect(clampPlacement({ x: -10, y: 5, w: 20, h: 10 })).toEqual({ x: 0, y: 5, w: 40, h: 30 })
  })
})

describe('a plan\'s own picture and shapes', () => {
  it('renames, sets a picture, and adds, updates and removes shapes without touching the original', () => {
    const base = first(addPlan(emptyDraft(), '一层'))
    expect(renamePlan(base, '  ').name).toBe('一层'); expect(renamePlan(base, '二层').name).toBe('二层')
    expect(setImage(base, { data: 'data:image/jpeg;base64,AA', w: 10, h: 10 }).image).not.toBeNull()
    const one = addShape(base, { kind: 'room', x: 10, y: 10, w: 200, h: 100, name: '一厅' })
    const two = addShape(one, { kind: 'label', x: 50, y: 50, text: '入口' })
    expect(base.shapes).toHaveLength(0); expect(two.shapes).toHaveLength(2)
    expect(new Set(two.shapes.map(s => s.id)).size).toBe(2)
    const renamed = updateShape(two, two.shapes[0]!.id, { name: '二厅' })
    expect((renamed.shapes[0] as { name: string }).name).toBe('二厅'); expect((two.shapes[0] as { name: string }).name).toBe('一厅')
    expect(removeShape(renamed, renamed.shapes[0]!.id).shapes).toHaveLength(1)
  })
})

describe('draft storage format', () => {
  const draft = updateActive(addPlan(emptyDraft(), '一层', [zone('z1')]), p => addShape(p, { kind: 'line', points: [0, 0, 100, 100] }))
  it('round-trips a valid draft', () => { expect(parseDraft(JSON.stringify(draft))).toEqual(draft) })
  it('rejects broken, old-format, duplicated or oversized drafts instead of guessing', () => {
    expect(parseDraft('not json')).toBeNull()
    expect(parseDraft(JSON.stringify({ version: 1, image: null, shapes: [], placements: {} }))).toBeNull()
    expect(parseDraft(JSON.stringify({ ...draft, plans: [{ ...draft.plans[0]!, placements: { z1: { x: 'a', y: 0, w: 1, h: 1 } } }] }))).toBeNull()
    expect(parseDraft(JSON.stringify({ ...draft, plans: [draft.plans[0], draft.plans[0]] }))).toBeNull()
    const big = (id: string) => ({ ...draft.plans[0]!, id, image: { data: 'data:image/jpeg;base64,' + 'x'.repeat(2_400_000), w: 10, h: 10 } })
    expect(parseDraft(JSON.stringify({ ...draft, plans: [big('a'), big('b')] }))).toBeNull()
    expect(parseDraft(JSON.stringify({ ...draft, plans: [{ ...draft.plans[0]!, image: { data: 'x'.repeat(100), w: 10, h: 10 } }] }))).toBeNull()
  })
  it('falls back to the first plan when the saved active one is gone', () => {
    expect(parseDraft(JSON.stringify({ ...draft, activeId: 'missing' }))!.activeId).toBe(draft.plans[0]!.id)
  })
})

describe('heat rendered from the counts over the plan', () => {
  const plan = (placements: Record<string, { x: number; y: number; w: number; h: number }>): Plan => ({ id: 'p', name: 'p', image: null, shapes: [], placements })
  const hottest = (cells: number[][]) => {
    const flat = cells.flat(), at = flat.indexOf(Math.max(...flat)), cols = cells[0]!.length
    return { x: (at % cols + .5) / cols * PLAN_W, y: (Math.floor(at / cols) + .5) / cells.length * PLAN_H, value: Math.max(...flat) }
  }
  it('peaks over the zone with the most passages and is normalised to 1', () => {
    const p = plan({ a: { x: 100, y: 100, w: 200, h: 120 }, b: { x: 1000, y: 500, w: 200, h: 120 } })
    const spot = hottest(heatCells(p, { a: 10, b: 400 }))
    expect(spot.value).toBeCloseTo(1)
    expect(spot.x).toBeGreaterThan(1000 - 60); expect(spot.x).toBeLessThan(1200 + 60)
    expect(spot.y).toBeGreaterThan(500 - 60); expect(spot.y).toBeLessThan(620 + 60)
    expect(heatCells(p, { a: 400, b: 10 }).flat().filter(v => v > 0.5).length).toBeGreaterThan(0)
  })
  it('stays completely cold when nothing was counted, and ignores zones that are not on this plan or have no count', () => {
    const p = plan({ a: { x: 100, y: 100, w: 200, h: 120 } })
    expect(Math.max(...heatCells(p, {}).flat())).toBe(0)
    expect(Math.max(...heatCells(p, { a: 0 }).flat())).toBe(0)
    expect(Math.max(...heatCells(p, { elsewhere: 99 }).flat())).toBe(0)
    expect(heatCells(plan({}), { a: 5 }).flat().every(v => v === 0)).toBe(true)
  })
  it('puts the same zone\'s heat at its own place on each plan', () => {
    const one = plan({ a: { x: 100, y: 100, w: 200, h: 120 } }), two = plan({ a: { x: 1200, y: 700, w: 200, h: 120 } })
    expect(hottest(heatCells(one, { a: 50 })).x).toBeLessThan(400)
    expect(hottest(heatCells(two, { a: 50 })).x).toBeGreaterThan(1100)
  })
})
