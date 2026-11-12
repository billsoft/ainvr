import { describe, it, expect, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SrsClient, supportsRtcHevc } from '../services/srsClient.js';

describe('SrsClient', () => {
  it('回归：SRS 返回非 2xx 状态码时 online 必须置 false（此前只有网络异常/code!==0 两个分支会置 false，漏了这一个）', async () => {
    let shouldFail = false;
    const fakeSrs = http.createServer((req, res) => {
      if (shouldFail) {
        res.writeHead(500);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, streams: [] }));
    });
    await new Promise<void>((resolve) => fakeSrs.listen(0, '127.0.0.1', resolve));
    const { port } = fakeSrs.address() as AddressInfo;

    try {
      const client = new SrsClient({
        apiHost: `127.0.0.1:${port}`,
        timeoutMs: 1000,
        cacheTtlMs: 0, // 不缓存，确保每次都真的重新探测
      });

      expect(await client.isOnline()).toBe(true); // 先确认能拿到一次成功的 online=true

      shouldFail = true;
      expect(await client.isOnline()).toBe(false); // SRS 开始返回 500，online 必须跟着翻转
    } finally {
      await new Promise<void>((resolve) => fakeSrs.close(() => resolve()));
    }
  });


  it('SRS 不可达时 isOnline 返回 false', async () => {
    const client = new SrsClient({
      apiHost: '127.0.0.1:19859', // 不存在的端口
      timeoutMs: 1000,
      cacheTtlMs: 100,
    });
    const online = await client.isOnline();
    expect(online).toBe(false);
    const streams = await client.listStreams();
    expect(Array.isArray(streams)).toBe(true);
    expect(streams).toHaveLength(0);
  });

  it('真实 SRS 时 isOnline 返回 true（如果 SRS 在运行）', async () => {
    const client = new SrsClient({
      apiHost: '127.0.0.1:1985',
      timeoutMs: 2000,
      cacheTtlMs: 100,
    });
    const online = await client.isOnline();
    console.log('  真实 SRS 在线:', online);
    // 不硬断言，因为测试环境 SRS 可能不在；只验证不抛错
    expect(typeof online).toBe('boolean');
  });

  it('缓存生效：连续两次 listStreams 只发一次请求', async () => {
    const client = new SrsClient({
      apiHost: '127.0.0.1:19859',
      timeoutMs: 500,
      cacheTtlMs: 5000,
    });
    const t0 = Date.now();
    const s1 = await client.listStreams();
    const t1 = Date.now();
    const s2 = await client.listStreams();
    const t2 = Date.now();
    // 第一次慢（等超时），第二次快（缓存命中）
    const firstMs = t1 - t0;
    const secondMs = t2 - t1;
    console.log(`  第一次: ${firstMs}ms, 第二次: ${secondMs}ms`);
    expect(secondMs).toBeLessThan(firstMs * 0.5); // 至少快一半
  });

  it('getVersion 从 SRS /api/v1/versions 实时读取版本（不再用设置里写死的字符串）', async () => {
    const fakeSrs = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url?.startsWith('/api/v1/versions')) {
        res.end(JSON.stringify({ code: 0, data: { major: 7, minor: 0, revision: 162, version: '7.0.162' } }));
      } else {
        res.end(JSON.stringify({ code: 0, streams: [] }));
      }
    });
    await new Promise<void>((resolve) => fakeSrs.listen(0, '127.0.0.1', resolve));
    const { port } = fakeSrs.address() as AddressInfo;
    try {
      const client = new SrsClient({ apiHost: `127.0.0.1:${port}`, timeoutMs: 1000 });
      expect(await client.getVersion()).toBe('7.0.162');
    } finally {
      await new Promise<void>((resolve) => fakeSrs.close(() => resolve()));
    }
  });

  it('getVersion 在 SRS 不可达时返回 null，不抛错', async () => {
    const client = new SrsClient({ apiHost: '127.0.0.1:19859', timeoutMs: 500 });
    expect(await client.getVersion()).toBeNull();
  });

  it('supportsRtcHevc：rtmp→WebRTC 的 H.265 从 SRS 7.0.33 起才有', () => {
    expect(supportsRtcHevc('7.0.162')).toBe(true);
    expect(supportsRtcHevc('7.0.33')).toBe(true);
    expect(supportsRtcHevc('7.0.32')).toBe(false);
    expect(supportsRtcHevc('6.0.191')).toBe(false);
    expect(supportsRtcHevc('8.0.1')).toBe(true);
    expect(supportsRtcHevc(null)).toBe(false);
    expect(supportsRtcHevc('garbage')).toBe(false);
  });
});

describe('SrsClient with more than ten streams', () => {
  it('lists every stream: the media server returns only ten unless a count is asked for', async () => {
    const all = Array.from({ length: 16 }, (_, i) => ({ id: 'vid-' + i, name: 'cam-' + i, app: 'live', publish: { active: true }, video: { width: 1920, height: 1080 } }));
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const count = Number(url.searchParams.get('count') ?? 10), start = Number(url.searchParams.get('start') ?? 0);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code: 0, streams: url.pathname.startsWith('/api/v1/streams') ? all.slice(start, start + count) : [] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const client = new SrsClient({ apiHost: '127.0.0.1:' + (server.address() as AddressInfo).port, timeoutMs: 2000, cacheTtlMs: 0 });
      const streams = await client.listStreams();
      expect(streams.map(s => s.name).sort()).toEqual(all.map(s => s.name).sort());
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});


it('bounds stalled JSON bodies and allows the next request to recover', async () => {
  let stalled = true;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (stalled) { res.write('{"code":'); return; }
    res.end(JSON.stringify({code:0, streams:[]}));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new SrsClient({apiHost:`127.0.0.1:${(server.address() as AddressInfo).port}`, timeoutMs:100, cacheTtlMs:0});
    expect(await client.isOnline()).toBe(false);
    stalled = false;
    expect(await client.isOnline()).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 3000);
