import {describe,it,expect} from 'vitest'
import {distanceToZone,approachContour} from './ApproachBand'
describe('source pixel approach geometry',()=>{
 it('uses Euclidean distance around corners and excludes interior',()=>{
  const p:[number,number][]=[[100,100],[200,100],[200,200],[100,200]]
  expect(distanceToZone([150,150],p)).toBe(-50)
  expect(distanceToZone([230,240],p)).toBe(50)
  expect(distanceToZone([250,150],p)).toBe(50)
 })
 it('renders concave offsets as continuous finite paths clipped to the image',()=>{
  const path=approachContour([[20,20],[180,20],[180,60],[60,60],[60,180],[20,180]],200,200,10)
  expect(path).toContain('M');expect(path).toContain('L');expect(path).not.toMatch(/NaN|Infinity/)
  const values=path.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
  expect(values.every(v=>v>=0&&v<=200)).toBe(true)
 })
})
