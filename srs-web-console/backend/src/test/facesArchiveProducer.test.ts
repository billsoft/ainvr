import { it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Binary, Long, ObjectId } from 'mongodb';
import { FacesMongo } from '../store/facesMongo.js';
import { FacesError } from '../services/facesContract.js';
import { FacesArchiveProducer, facesArchiveCapture, facesSourceLabels, type FacesCaptureSource } from '../services/facesArchiveProducer.js';
const source: FacesCaptureSource = { processor_id: 'face-test', channel_id: randomUUID(), recording_channel_id: randomUUID(), retention_days: 7, capture_supported: true, reason: null, face_labels: ['class:0'], source_revision: 'generation-one' };
function row(index: number) { return { _id: new ObjectId(), image_id: randomUUID(), task_type: 'face_detection', channel_id: source.processor_id, bbox: { x: 0, y: 0, w: 30, h: 30 }, label_id: 'class:0', track_id: `track${index}`, timestamp: Date.now() / 1000, frame_pts_ns: Long.fromString('9007199254740993'), model_extra: { observation_source: { schema_version: '1.0', stream_session_id: 'test-session', source_pts_ns: '9007199254740993', source_frame_index: String(index), frame_width: 640, frame_height: 480 } }, original_image: { format: 'jpg', width: 30, height: 30, data: new Binary(Buffer.from([255, 216, 1, 255, 217])) } }; }
it('includes root face with general auxiliaries and preserves non-primary root labels', () => {
  const config = { model: { adapter: 'scrfd_bpu' }, analysis_pipeline: { execution: 'serial', nodes: [{ id: 'objects', model: { adapter: 'yolo26_bpu' } }] } };
  expect(facesSourceLabels(config as never)).toEqual(['class:0']);
  expect(facesSourceLabels({ ...config, analysis_pipeline: { ...config.analysis_pipeline, root_id: 'retained-face' } } as never)).toEqual(['node:retained-face:class:0']);
  expect(facesSourceLabels({ ...config, model: { adapter: 'yoloface' } } as never)).toEqual(['class:0']);
});
it('requires exact provenance and original JPEG, preserves 64-bit PTS, rejects enhanced-only', () => {
  const good = row(1); expect(facesArchiveCapture(good, source, 'mbf')?.source_pts_ns).toBe('9007199254740993');
  expect(facesArchiveCapture({ ...good, original_image: null, image: good.original_image }, source, 'mbf')).toBeNull();
  expect(facesArchiveCapture({ ...good, label_id: 'class:1' }, source, 'mbf')).toBeNull();
  expect(facesArchiveCapture({ ...good, frame_pts_ns: Long.fromString('123') }, source, 'mbf')).toBeNull();
});
const uri = process.env.AINVR_FACES_TEST_MONGO_URI;
if (uri && (new URL(uri).hostname !== '127.0.0.1' || new URL(uri).port !== '27932')) throw Error('Requires isolated Mongo27932');
it.skipIf(!uri)('persistent archive producer skips poison samples, retries dependency failures and consumes later frames', async () => {
  const name = `faces_producer_test_${randomUUID().replaceAll('-', '')}`;
  const mongo = new FacesMongo(async () => ({ uri: uri!, database: name }));
  const capture = vi.fn(async (input: { frame_id: string }) => ({ record: { id: randomUUID(), quality: { state: 'qualified' }, expires_at: new Date(Date.now() + 60000).toISOString() }, watchlist_candidates: [] }));
  const runtime = { status: async () => ({ ready: true, active_model: 'mbf', spaces: [{ model: 'mbf', space_id: 'a'.repeat(64) }] }), capture };
  const producer = new FacesArchiveProducer(mongo, runtime as never, async () => [source], () => true);
  try {
    await producer.tick(); const db = await mongo.db();
    capture.mockRejectedValueOnce(new FacesError('invalid_image', 'bad JPEG', 422));
    await db.collection(`snapshots_${source.processor_id}`).insertMany([row(1), row(2)]);
    await producer.tick(); expect(capture.mock.calls.map(call => call[0].frame_id)).toEqual(['test-session:1', 'test-session:2']);
    await producer.tick(); expect(capture).toHaveBeenCalledTimes(2);
    expect(await db.collection('faces_archive_checkpoints').findOne({})).toMatchObject({ failed_samples: 1, last_failure_reason: 'invalid_image' });
    capture.mockRejectedValueOnce(new FacesError('extractor_unavailable', 'retry', 503));
    await db.collection(`snapshots_${source.processor_id}`).insertOne(row(3));
    await expect(producer.tick()).rejects.toMatchObject({ statusCode: 503 });
    await producer.tick(); expect(capture.mock.calls.at(-1)?.[0].frame_id).toBe('test-session:3');
    expect(capture).toHaveBeenCalledTimes(4);
    // Restart uses the durable cursor and successful track marker.
    await new FacesArchiveProducer(mongo, runtime as never, async () => [source], () => true).tick();
    expect(capture).toHaveBeenCalledTimes(4);
  } finally { await (await mongo.db()).dropDatabase(); await mongo.close(); }
});
