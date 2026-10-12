import { expect, it, vi } from 'vitest'
import { PerspectiveCamera, SphereGeometry } from 'three'
import { erpPoint, clipNear, drawPanoramaDetections } from '@/components/player/panoramaDetection'

it('matches the actual video sphere UV orientation, including flipped X', () => {
  const sphere = new SphereGeometry(10, 64, 32).scale(-1, 1, 1)
  const uv = sphere.getAttribute('uv'), xyz = sphere.getAttribute('position')
  for (let i = 65; i < xyz.count - 65; i++) {
    const p = erpPoint(uv.getX(i) * 2000, (1 - uv.getY(i)) * 1000, 2000, 1000)
    expect(p[0]).toBeCloseTo(xyz.getX(i), 4)
    expect(p[1]).toBeCloseTo(xyz.getY(i), 4)
    expect(p[2]).toBeCloseTo(xyz.getZ(i), 4)
  }
  sphere.dispose()
})
it('wraps the seam continuously and clips rear-facing segments', () => {
  const a = erpPoint(1999, 500, 2000, 1000), b = erpPoint(2001, 500, 2000, 1000)
  expect(Math.hypot(...a.map((v, i) => v - b[i]!) as [number, number, number])).toBeLessThan(.1)
  expect(clipNear([1, 0, 1], [2, 0, 2])).toBeNull()
  const clipped = clipNear([0, 0, -1], [1, 0, 1])!
  expect(clipped[1][2]).toBe(-.1)
})
it('projects front faces, hides rear labels, rotates into view and handles empty results', () => {
  const camera = new PerspectiveCamera(75, 2, .1, 20)
  camera.updateMatrixWorld()
  const ctx = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), arc: vi.fn(), fill: vi.fn(), measureText: () => ({ width: 40 }) }
  const draw = (x: number) => drawPanoramaDetections(ctx as unknown as CanvasRenderingContext2D,
    [{ bbox: { x, y: 450, w: 100, h: 100 }, class_name: 'face', confidence: .9, class_id: 0 }],
    { view: camera.matrixWorldInverse.elements, projection: camera.projectionMatrix.elements }, 800, 400, 2000, 1000)
  draw(1450)
  expect(ctx.fillText).toHaveBeenCalledTimes(1)
  ctx.fillText.mockClear(); ctx.lineTo.mockClear()
  draw(450)
  expect(ctx.fillText).not.toHaveBeenCalled(); expect(ctx.lineTo).not.toHaveBeenCalled()
  camera.rotation.y = Math.PI; camera.updateMatrixWorld()
  draw(450)
  expect(ctx.fillText).toHaveBeenCalledTimes(1)
  ctx.lineTo.mockClear()
  drawPanoramaDetections(ctx as unknown as CanvasRenderingContext2D, [], null, 800, 400, 2000, 1000)
  expect(ctx.lineTo).not.toHaveBeenCalled()
})
