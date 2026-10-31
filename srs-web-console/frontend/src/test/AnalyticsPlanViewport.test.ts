import { expect, it } from 'vitest'
import { planViewport, type Plan } from '@/pages/Analytics/plan/planModel'
const portrait: Plan = { id: 'p', name: '竖图', image: { data: 'data:image/png;base64,test', w: 800, h: 1200 }, shapes: [], placements: {} }
it('fits planned content without a background and leaves editing coordinates intact',()=>{
 const plan:Plan={...portrait,image:null,placements:{z:{x:300,y:200,w:200,h:100}}}
 const before=JSON.stringify(plan),view=planViewport(plan,true)
 expect(view.w).toBeLessThan(600);expect(view.x+view.w/2).toBeCloseTo(400)
 expect(view.y+view.h/2).toBeCloseTo(250);expect(JSON.stringify(plan)).toBe(before)
 expect(planViewport(plan,false)).toEqual({x:0,y:0,w:1600,h:900})
})
it('fits portrait and wide backgrounds without distortion while keeping the image centered', () => {
  expect(planViewport(portrait, true)).toEqual({ x: 500, y: 0, w: 600, h: 900 })
  expect(planViewport({ ...portrait, image: { ...portrait.image!, w: 1600, h: 600 } }, true)).toEqual({ x: 0, y: 150, w: 1600, h: 600 })
  expect(planViewport(portrait)).toEqual({ x: 0, y: 0, w: 1600, h: 900 })
})
it('keeps saved frames, heat tails and drawn geometry in view without moving any placement', () => {
  const plan: Plan = { ...portrait, placements: { entry: { x: 100, y: 200, w: 200, h: 100 } }, shapes: [{ id: 's', kind: 'line', points: [1300, 100, 1500, 800] }] }
  const before = JSON.stringify(plan)
  const view = planViewport(plan, true)
  expect(view.x).toBeLessThanOrEqual(-30)
  expect(view.x + view.w).toBeGreaterThanOrEqual(1504)
  expect(view.x + view.w / 2).toBe(800)
  expect(view.y + view.h / 2).toBe(450)
  expect(JSON.stringify(plan)).toBe(before)
})
