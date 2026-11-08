import { describe, expect, it } from 'vitest'
import { trackingUnavailableReason } from '@/features/trackingPolicy'
describe('tracking configured rate boundary', () => {
 it.each([2, 3, 5, 0])('allows supported YOLO sampling at %s FPS', fps => {
  expect(trackingUnavailableReason('yolo26x', fps)).toBeNull()
 })
 it.each([1.99, 1, -1, NaN, Infinity])('rejects insufficient or invalid rate %s', fps => {
  expect(trackingUnavailableReason('yolo26x', fps)).not.toBeNull()
 })
 it('does not enable low-frequency model tracking by changing the rate', () => {
  expect(trackingUnavailableReason('locateanything-3b', 2)).not.toBeNull()
 })
})
