import { describe, expect, it } from 'vitest';
import { floorPlanDocumentSchema } from '../store/floorPlanDocument.js';

const document = { id: 'p123', name: 'Floor', shapes: [{ id: 's1', kind: 'room', x: 1, y: 2, w: 80, h: 60, name: 'Room' }], placements: { 'zone-1': { x: 5, y: 8, w: 40, h: 30 } } };
describe('floor plan document', () => {
  it('accepts existing display shapes and zone placements', () => {
    expect(floorPlanDocumentSchema.parse(document)).toEqual(document);
  });
  it('rejects arming data, invalid geometry and duplicate shape IDs', () => {
    expect(floorPlanDocumentSchema.safeParse({ ...document, arming: {} }).success).toBe(false);
    expect(floorPlanDocumentSchema.safeParse({ ...document, placements: { z: { x: 0, y: 0, w: -1, h: 1 } } }).success).toBe(false);
    expect(floorPlanDocumentSchema.safeParse({ ...document, shapes: [document.shapes[0], document.shapes[0]] }).success).toBe(false);
  });
  it('limits shape count and placement count', () => {
    expect(floorPlanDocumentSchema.safeParse({ ...document, shapes: Array.from({ length: 1001 }, (_, i) => ({ id: 's' + i, kind: 'label', x: 1, y: 1, text: '' })) }).success).toBe(false);
    expect(floorPlanDocumentSchema.safeParse({ ...document, placements: Object.fromEntries(Array.from({ length: 1001 }, (_, i) => ['z' + i, { x: 0, y: 0, w: 1, h: 1 }])) }).success).toBe(false);
  });
});
