import { expect, it, vi } from 'vitest';
import { facesHistoryConnection } from '../services/facesRegistration.js';
import { buildSearchSourceCatalog } from '../services/searchSourceCatalog.js';
it('face Mongo authority uses applied snapshot_store without requiring text/history enabled', async () => {
  const store = { getServiceState: vi.fn(async () => ({ appliedVersion: 4 })),
    getVersionSnapshotForService: vi.fn(async () => [{ group: 'system', name: 'settings', config: { enabled: false, snapshot_store: { mongo_uri: '${secret:ai-service/snapshot_store.mongo_uri/v1}', db_name: 'isolated_faces' } } }]),
    getSecret: vi.fn(async () => 'mongodb://127.0.0.1:27932'),
  };
  expect(await facesHistoryConnection(store as never)).toEqual({ uri: 'mongodb://127.0.0.1:27932', database: 'isolated_faces' });
  expect(store.getVersionSnapshotForService).toHaveBeenCalledWith(4, 'ai-service');
  store.getServiceState.mockResolvedValueOnce({ appliedVersion: 4 }).mockResolvedValueOnce({ appliedVersion: 5 });
  expect(await facesHistoryConnection(store as never)).toBeNull();
});
it('a four-node processor keeps the real search/face output mapping', () => {
  const input = '11111111-1111-4111-a111-111111111111', output = '22222222-2222-4222-a222-222222222222';
  const channels = [{ id: input, name: 'Raw', app: 'live', streamName: 'raw' }, { id: output, name: 'Output', app: 'live', streamName: 'ai' }] as never;
  const processor = { id: 'four-node', config: { enabled: true, inference_fps: 10, analytics: { enabled: true, retention_days: 7 }, snapshot: { enabled: true },
    analysis_pipeline: { execution: 'serial', nodes: ['yolo26_bpu', 'scrfd_bpu', 'yolo26_bpu', 'yolo26_bpu'].map((adapter, index) => ({ id: String(index), model: { adapter } })) },
    stream: { url: 'rtmp://127.0.0.1/live/raw' }, publish: { enabled: true, target_url: 'rtmp://127.0.0.1/live/ai' } } };
  expect(buildSearchSourceCatalog(channels, [processor]).sources[0]).toMatchObject({ processor_id: 'four-node', channel_id: output, recording_channel_id: output });
});
