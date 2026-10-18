import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SnapshotImage } from '@/pages/RecognitionHistory/SnapshotImage'
import { snapshotPointPosition } from '@/utils/snapshotPoint'
import type { SnapshotItem } from '@/types/snapshot'

vi.mock('@/components/common/AuthImage', () => ({
  AuthImage: ({ alt, onImageLoaded }: { alt: string; onImageLoaded?: () => void }) => (
    <img alt={alt} src="fixture.jpg" onLoad={onImageLoaded} />
  ),
}))

const point: SnapshotItem = {
  image_id: 'point-1', channel_id: 'test', channel_name: 'test', frame_pts_ns: 123,
  timestamp: 123, model_name: 'locateanything', task_type: 'grounding',
  class_id: -1, class_name: 'person', confidence: null, bbox: null, landmarks: null,
  image_width: 1024, image_height: 576, enhanced: false,
  geometry_type: 'point', context_image: 'full_frame',
  point: { x: .5, y: .25, coordinate_space: 'normalized_full_frame' },
}

describe('Snapshot point image geometry', () => {
  it('keeps normalized full-frame points and maps minimum-JPU canvas padding', () => {
    expect(snapshotPointPosition(point)).toEqual({ x: .5, y: .25 })
    const padded = { ...point, point: { ...point.point!, context_image_rect: { x: 0, y: 0, w: 1, h: 1 / 17 } } }
    expect(snapshotPointPosition(padded)).toEqual({ x: .5, y: .25 / 17 })
    expect(padded.point.y).toBe(.25)
  })

  it('rejects malformed coordinates,wrong image meaning and invalid context rectangles', () => {
    expect(snapshotPointPosition({ ...point, geometry_type: undefined })).toBeNull()
    expect(snapshotPointPosition({ ...point, context_image: undefined })).toBeNull()
    for (const p of [
      { ...point.point!, x: NaN }, { ...point.point!, x: -1 },
      { ...point.point!, y: 1.1 },
      { ...point.point!, context_image_rect: { x: .5, y: 0, w: .6, h: 1 } },
      { ...point.point!, context_image_rect: { x: 0, y: 0, w: 1, h: 0 } },
    ]) expect(snapshotPointPosition({ ...point, point: p })).toBeNull()
    const malformed = { ...point, point: { ...point.point!, context_image_rect: null } } as unknown as SnapshotItem
    expect(snapshotPointPosition(malformed)).toBeNull()
  })

  it('draws the actual point only after its matching image loads', () => {
    const { container } = render(<SnapshotImage channelId="test" item={point} objectFit="contain" />)
    expect(screen.queryByTestId('snapshot-point-marker')).toBeNull()
    fireEvent.load(screen.getByAltText('person'))
    const marker = screen.getByTestId('snapshot-point-marker')
    expect(marker.getAttribute('viewBox')).toBe('0 0 1024 576')
    expect(marker.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet')
    const circle = container.querySelector('circle')!
    expect(Number(circle.getAttribute('cx'))).toBe(512)
    expect(Number(circle.getAttribute('cy'))).toBe(144)
    expect(container.querySelector('rect')).toBeNull()
  })

  it('uses cover projection for thumbnails and preserves the valid image content rectangle', () => {
    const padded: SnapshotItem = { ...point, image_height: 17,
      point: { ...point.point!, context_image_rect: { x: 0, y: 0, w: 1, h: 1 / 17 } } }
    const { container } = render(<SnapshotImage channelId="test" item={padded} />)
    fireEvent.load(screen.getByAltText('person'))
    expect(screen.getByTestId('snapshot-point-marker').getAttribute('preserveAspectRatio')).toBe('xMidYMid slice')
    expect(Number(container.querySelector('circle')!.getAttribute('cy'))).toBeCloseTo(.25)
    expect(container.querySelector('clipPath path')!.getAttribute('d')).toBe('M 0 0 H 1024 V 1 H 0 Z')
    const clipId = container.querySelector('clipPath')!.getAttribute('id')
    expect(container.querySelector('g')!.getAttribute('clip-path')).toBe(`url(#${clipId})`)
  })

  it('does not carry a marker over a changed image or original/processed variant', () => {
    const { rerender } = render(<SnapshotImage channelId="test" item={point} />)
    fireEvent.load(screen.getByAltText('person'))
    expect(screen.getByTestId('snapshot-point-marker')).toBeDefined()
    const previousImage = screen.getByAltText('person')
    rerender(<SnapshotImage channelId="test" item={point} variant="original" />)
    expect(screen.queryByTestId('snapshot-point-marker')).toBeNull()
    expect(screen.getByAltText('person')).not.toBe(previousImage)
    fireEvent.load(previousImage)
    expect(screen.queryByTestId('snapshot-point-marker')).toBeNull()
    fireEvent.load(screen.getByAltText('person'))
    expect(screen.getByTestId('snapshot-point-marker')).toBeDefined()
    rerender(<SnapshotImage channelId="test" item={{ ...point, image_id: 'point-2' }} variant="original" />)
    expect(screen.queryByTestId('snapshot-point-marker')).toBeNull()
  })

  it('preserves legacy box image behavior and refuses invalid image dimensions', () => {
    const legacy: SnapshotItem = { ...point, geometry_type: undefined, point: undefined,
      bbox: { x: 1, y: 2, w: 3, h: 4 } }
    const { rerender } = render(<SnapshotImage channelId="test" item={legacy} />)
    fireEvent.load(screen.getByAltText('person'))
    expect(screen.queryByTestId('snapshot-point-marker')).toBeNull()
    rerender(<SnapshotImage channelId="test" item={{ ...point, image_width: null }} />)
    fireEvent.load(screen.getByAltText('person'))
    expect(screen.queryByTestId('snapshot-point-marker')).toBeNull()
  })
})
