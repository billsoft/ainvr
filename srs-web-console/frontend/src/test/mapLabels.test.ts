import { describe, expect, it } from 'vitest'
import { layoutMapLabels, type LabelBox } from '@/pages/Analytics/plan/mapLabels'
import type { Placement } from '@/pages/Analytics/plan/planModel'

const viewport = { x: 0, y: 0, w: 800, h: 450 }
function expectInBounds(labels: LabelBox[], width: number, height: number) {
  for (const label of labels) {
    expect(label.x).toBeGreaterThanOrEqual(0)
    expect(label.y).toBeGreaterThanOrEqual(0)
    expect(label.x + label.w).toBeLessThanOrEqual(width)
    expect(label.y + label.h).toBeLessThanOrEqual(height)
  }
}
function expectSeparated(labels: LabelBox[]) {
  for (let i = 0; i < labels.length; i++) {
    for (const other of labels.slice(i + 1)) {
      const label = labels[i]!
      expect(
        label.x + label.w + 4 <= other.x || other.x + other.w + 4 <= label.x ||
        label.y + label.h + 4 <= other.y || other.y + other.h + 4 <= label.y,
        `${label.key} overlaps ${other.key}`,
      ).toBe(true)
    }
  }
}

describe('layoutMapLabels', () => {
  it('shares the centered map transform for offset viewports in wide and tall canvases', () => {
    const placements = { zone: { x: -50, y: 60, w: 100, h: 40 } }
    const view = { x: -100, y: 20, w: 400, h: 200 }
    const [wide] = layoutMapLabels(placements, ['zone'], view, 1000, 200, null)
    expect(wide).toMatchObject({ key: 'zone', anchorX: 400, anchorY: 60 })
    const [tall] = layoutMapLabels(placements, ['zone'], view, 400, 600, null)
    expect(tall).toMatchObject({ key: 'zone', anchorX: 100, anchorY: 260 })
  })

  it.each([[1366, 600], [800, 450], [320, 180]])('clamps edge labels inside a %i × %i canvas', (width, height) => {
    const placements = {
      topLeft: { x: 0, y: 0, w: 20, h: 20 },
      topRight: { x: 780, y: 0, w: 20, h: 20 },
      bottomLeft: { x: 0, y: 430, w: 20, h: 20 },
      bottomRight: { x: 780, y: 430, w: 20, h: 20 },
    }
    const labels = layoutMapLabels(placements, Object.keys(placements), viewport, width, height, null)
    expect(labels).toHaveLength(4)
    expectInBounds(labels, width, height)
    expectSeparated(labels)
  })

  it('avoids collisions across many crowded zones while keeping compact markers available', () => {
    const placements: Record<string, Placement> = Object.fromEntries(
      Array.from({ length: 24 }, (_, i) => [`zone-${i}`, { x: 350, y: 200, w: 100, h: 50 }]),
    )
    const keys = Object.keys(placements)
    const labels = layoutMapLabels(placements, keys, viewport, 800, 450, null)
    expect(new Set(labels.map(label => label.key))).toEqual(new Set(keys))
    expect(labels.some(label => label.compact)).toBe(true)
    expectInBounds(labels, 800, 450)
    expectSeparated(labels)
    expect(layoutMapLabels(placements, keys, viewport, 800, 450, null)).toEqual(labels)
    expect(placements['zone-0']).toEqual({ x: 350, y: 200, w: 100, h: 50 })

    const selected = keys.at(-1)!
    expect(labels.find(label => label.key === selected)?.compact).toBe(true)
    const prioritized = layoutMapLabels(placements, keys, viewport, 800, 450, selected)
    expect(prioritized[0]).toMatchObject({ key: selected, compact: false, ordinal: keys.length })
    expectSeparated(prioritized)
    expectInBounds(prioritized, 800, 450)
    for (const label of prioritized) expect(label.ordinal).toBe(keys.indexOf(label.key) + 1)
  })

  it('skips unplaced annotations and does not let an unplaced selection displace visible labels', () => {
    const placements = { placed: { x: 100, y: 100, w: 80, h: 40 } }
    const labels = layoutMapLabels(placements, ['missing', 'placed'], viewport, 800, 450, 'missing')
    expect(labels).toHaveLength(1)
    expect(labels[0]).toMatchObject({ key: 'placed', compact: false })
    expect(layoutMapLabels({}, ['missing'], viewport, 800, 450, null)).toEqual([])
  })

  it('handles a minimum-size canvas and skips surfaces too small for a marker', () => {
    const placements = { zone: { x: 0, y: 0, w: 100, h: 50 } }
    const labels = layoutMapLabels(placements, ['zone'], viewport, 24, 24, 'zone')
    expect(labels).toHaveLength(1)
    expectInBounds(labels, 24, 24)
    expect(layoutMapLabels(placements, ['zone'], viewport, 23, 100, null)).toEqual([])
    expect(layoutMapLabels(placements, ['zone'], viewport, 100, 23, null)).toEqual([])
  })
})
