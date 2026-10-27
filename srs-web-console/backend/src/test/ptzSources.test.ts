import { describe, it, expect } from 'vitest';
import { resolvePtzSource } from '../services/ptzSources.js';
import type { Channel } from '../types/channel.js';
const channel = (id: string, streamName: string): Channel => ({
  id,
  name: id,
  streamName,
  upstreamProtocol: 'rtmp',
  downstreamProtocols: ['flv'],
  inputGeneration: `gen-${id}`,
  createdAt: 1,
  updatedAt: 1,
});
const ai = (id: string, input: string, output: string) => ({
  id,
  config: {
    stream: { url: `rtmp://127.0.0.1:1935/live/${input}` },
    publish: { enabled: true, effective_target_url: `rtmp://127.0.0.1:1935/live/${output}` },
  },
});
describe('physical PTZ source resolution', () => {
  it('isolates two processors sharing a camera and follows an AI chain', () => {
    const channels = [
      channel('camera', 'raw'),
      channel('ai-a', 'a'),
      channel('ai-b', 'b'),
      channel('ai-c', 'c'),
    ];
    const links = [
      ai('processor-a', 'raw', 'a'),
      ai('processor-b', 'raw', 'b'),
      ai('processor-c', 'a', 'c'),
    ];
    const s = resolvePtzSource('ai-c', channels, links);
    expect(s.root.id).toBe('camera');
    expect(s.sourceIds).toEqual(['ai-a', 'ai-b', 'ai-c', 'camera']);
    expect(s.processorIds).toEqual(['processor-a', 'processor-b', 'processor-c']);
  });
  it('fails closed on duplicate publishers, missing source and cycles', () => {
    const channels = [channel('camera', 'raw'), channel('camera-2', 'raw2'), channel('ai-a', 'a')];
    expect(() =>
      resolvePtzSource('ai-a', channels, [ai('p1', 'raw', 'a'), ai('p2', 'raw2', 'a')]),
    ).toThrow('ptz_source_ambiguous');
    expect(() => resolvePtzSource('ai-a', channels, [ai('p', 'missing', 'a')])).toThrow(
      'ptz_source_ambiguous',
    );
    expect(() => resolvePtzSource('ai-a', channels, [ai('p', 'a', 'a')])).toThrow(
      'ptz_source_ambiguous',
    );
  });
  it('shares ONVIF main/sub profiles and excludes another NVR sensor', () => {
    const channels = [channel('main', 'raw'), channel('sub', 'sub'), channel('other', 'other')];
    channels.forEach(
      (c, i) =>
        (c.onvif = {
          deviceId: 'nvr',
          deviceVersion: 1,
          service: 'media1',
          profileToken: c.id,
          videoSource: i === 2 ? 'sensor-2' : 'sensor-1',
        }),
    );
    expect(resolvePtzSource('main', channels, []).sourceIds).toEqual(['main', 'sub']);
    const before = resolvePtzSource('main', channels, []).fingerprint;
    channels[0]!.inputGeneration = 'new-generation';
    expect(resolvePtzSource('main', channels, []).fingerprint).not.toBe(before);
  });
});
