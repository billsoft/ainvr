import { describe, it, expect } from 'vitest';
import { normalizeInput, hasVideo, safeChannel, videoProgress } from '../services/ingestPolicy.js';

describe('multi protocol input contracts', () => {
  it('rejects stream paths and delimiters before source work starts', () => {
    for (const streamName of ['cam/path', 'cam?override=1', 'cam#other', '摄像头']) {
      expect(() => normalizeInput({ upstreamProtocol: 'rtmp', streamName } as any)).toThrow();
    }
  });
  it('rejects missing RTSP source and non-video URL', () => {
    expect(() => normalizeInput({ upstreamProtocol: 'rtsp' } as any)).toThrow();
    expect(() => normalizeInput({ upstreamProtocol: 'rtsp', rtspUrl: 'http://camera/live' } as any)).toThrow();
  });
  it('extracts credentials without returning them', () => {
    const v = normalizeInput({ upstreamProtocol: 'rtsp', rtspUrl: 'rtsp://operator:secret@camera/live' } as any);
    expect(v.secret).toContain('secret');
    expect(v.publicUrl).toBe('rtsp://camera/live');
    expect(JSON.stringify(safeChannel({ rtspUrl: v.publicUrl, sourceRef: 'secret-key' } as any))).not.toContain('secret-key');
  });
  it('connection without video is offline', () => {
    expect(hasVideo({ publish: { active: true }, frames: 0 })).toBe(false);
    expect(hasVideo({ publish: { active: true }, frames: 10, video: { codec: 'H264' } })).toBe(true);
    expect(hasVideo({ publish: { active: false }, frames: 100, video: { codec: 'HEVC' } })).toBe(false);
  });
  it('SRT publishers are judged by received bytes because SRS 7 never counts their frames', () => {
    // Observed on SRS 7.0.162: an SRT camera at 2 Mbps reports frames=0 and video_frames=0 forever.
    const srt = { tcUrl: 'srt://127.0.0.1/live', publish: { active: true, cid: 'a' }, frames: 0, video_frames: 0,
      recv_bytes: 71263482, video: { codec: 'H264' } };
    expect(hasVideo(srt)).toBe(true);
    expect(videoProgress(srt)).toBe(71263482);
    expect(hasVideo({ ...srt, recv_bytes: 0 })).toBe(false);
    expect(hasVideo({ ...srt, video: undefined })).toBe(false);
    expect(hasVideo({ ...srt, publish: { active: false } })).toBe(false);
    // RTMP keeps the stricter frame counter: bytes alone (e.g. audio only) are not video.
    expect(hasVideo({ ...srt, tcUrl: 'rtmp://127.0.0.1/live' })).toBe(false);
    expect(videoProgress({ ...srt, tcUrl: 'rtmp://127.0.0.1/live', frames: 12 })).toBe(12);
  });
  it('non-RTSP input cannot retain a source password', () => {
    expect(() => normalizeInput({ upstreamProtocol: 'rtmp', rtspUrl: 'rtsp://camera/live', inputPassword: 'x' } as any)).toThrow();
  });
});
