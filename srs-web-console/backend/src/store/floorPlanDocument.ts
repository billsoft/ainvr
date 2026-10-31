import { z } from 'zod';

// Display geometry and zone IDs only; arming data remains authoritative elsewhere.
const id = z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/);
const coord = z.number().finite().min(-100000).max(100000);
const size = z.number().finite().min(1).max(100000);
const shape = z.discriminatedUnion('kind', [
  z.object({ id, kind: z.literal('room'), x: coord, y: coord, w: size, h: size, name: z.string().max(200) }).strict(),
  z.object({ id, kind: z.literal('line'), points: z.tuple([coord, coord, coord, coord]) }).strict(),
  z.object({ id, kind: z.literal('label'), x: coord, y: coord, text: z.string().max(200) }).strict(),
]);
const placement = z.object({ x: coord, y: coord, w: size, h: size }).strict();
export const floorPlanDocumentSchema = z.object({
  id: id.max(64), name: z.string().min(1).max(80),
  shapes: z.array(shape).max(1000),
  placements: z.record(id, placement).refine(v => Object.keys(v).length <= 1000),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.shapes.map(s => s.id)).size !== value.shapes.length)
    ctx.addIssue({ code: 'custom', message: 'duplicate shape ID' });
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 256 * 1024)
    ctx.addIssue({ code: 'custom', message: 'document too large' });
});
export type FloorPlanDocument = z.infer<typeof floorPlanDocumentSchema>;
