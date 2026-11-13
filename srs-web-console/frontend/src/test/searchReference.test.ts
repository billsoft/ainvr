import { expect, it } from 'vitest'
import { checkReferenceFile, checkReferenceSize, cropBackground, isWholePicture, normalizeCrop, referencePlan, ReferenceImageError } from '@/features/searchReference'

it('keeps a selection inside the picture and never smaller than the minimum', () => {
  expect(normalizeCrop({ x: 0.9, y: -0.2, w: 0.5, h: 0.001 })).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.04 })
  expect(normalizeCrop({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 })).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 })
})

it('treats a selection covering the whole picture as the whole picture', () => {
  expect(isWholePicture(null)).toBe(true)
  expect(isWholePicture({ x: 0, y: 0, w: 1, h: 1 })).toBe(true)
  expect(isWholePicture({ x: 0.1, y: 0, w: 0.9, h: 1 })).toBe(false)
})

it('crops in picture pixels and scales to even dimensions within the upload bound', () => {
  // A 4000 x 3000 photo, bag selected in the lower right quarter.
  const plan = referencePlan(4000, 3000, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
  expect(plan).toMatchObject({ sx: 2000, sy: 1500, sw: 2000, sh: 1500 })
  expect(Math.max(plan.width, plan.height)).toBeLessThanOrEqual(1024)
  expect(plan.width % 2).toBe(0); expect(plan.height % 2).toBe(0)
  // Small pictures are not enlarged, but an odd side becomes even.
  expect(referencePlan(301, 199, null)).toMatchObject({ sx: 0, sy: 0, sw: 301, sh: 199, width: 300, height: 198 })
})

it('shows only the selected part in the thumbnail', () => {
  expect(cropBackground(null)).toMatchObject({ backgroundSize: '100% 100%', backgroundPosition: '0% 0%' })
  const view = cropBackground({ x: 0.5, y: 0, w: 0.5, h: 0.25 })
  expect(view.backgroundSize).toBe('200% 400%')
  expect(view.backgroundPosition).toBe('100% 0%')
})

it('names unsupported, empty, oversized and tiny pictures in words', () => {
  expect(() => checkReferenceFile(new Blob(['x'], { type: 'image/gif' }))).toThrow(ReferenceImageError)
  expect(() => checkReferenceFile(new Blob([], { type: 'image/png' }))).toThrow('图片内容为空')
  expect(() => checkReferenceFile(new Blob(['x'], { type: 'image/jpeg' }))).not.toThrow()
  expect(() => checkReferenceSize(20, 400)).toThrow('图片太小')
  expect(() => checkReferenceSize(10000, 6000)).toThrow('分辨率过大')
})
