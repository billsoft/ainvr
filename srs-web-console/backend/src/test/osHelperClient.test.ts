import { describe, it, expect } from 'vitest';
import {
  osHelperConfigFromEnv, listInterfaces, applyIpConfig, wifiConnect, getFallback,
} from '../services/osHelperClient.js';

describe('osHelperConfigFromEnv', () => {
  it('两个环境变量都配置时返回 config，baseUrl 去掉末尾斜杠', () => {
    const cfg = osHelperConfigFromEnv({
      OS_HELPER_URL: 'http://host.docker.internal:8299/',
      OS_HELPER_TOKEN: 'tok-123',
    } as NodeJS.ProcessEnv);
    expect(cfg).toEqual({ baseUrl: 'http://host.docker.internal:8299', token: 'tok-123' });
  });

  it('缺 URL 或缺 token 时返回 null（网络管理整体禁用，不是报错）', () => {
    expect(osHelperConfigFromEnv({ OS_HELPER_TOKEN: 'tok' } as NodeJS.ProcessEnv)).toBeNull();
    expect(osHelperConfigFromEnv({ OS_HELPER_URL: 'http://x' } as NodeJS.ProcessEnv)).toBeNull();
    expect(osHelperConfigFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('listInterfaces', () => {
  const config = { baseUrl: 'http://host.docker.internal:8299', token: 'tok-123' };

  it('带 Bearer token 请求正确路径，透传 interfaces 数组', async () => {
    let capturedUrl = '';
    let capturedHeaders: HeadersInit | undefined;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ ok: true, interfaces: [{ name: 'eth0' }] }), { status: 200 });
    }) as typeof fetch;

    const result = await listInterfaces(config, false, fakeFetch);
    expect(result).toEqual([{ name: 'eth0' }]);
    expect(capturedUrl).toBe('http://host.docker.internal:8299/network/interfaces?all=false');
    expect((capturedHeaders as Record<string, string>).Authorization).toBe('Bearer tok-123');
  });

  it('os-helper 返回非 2xx 时抛出带 error 文本的异常', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })) as typeof fetch;
    await expect(listInterfaces(config, false, fakeFetch)).rejects.toThrow('forbidden');
  });

  it('interfaces 字段缺失时降级为空数组，不抛异常', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
    expect(await listInterfaces(config, false, fakeFetch)).toEqual([]);
  });
});

describe('applyIpConfig', () => {
  const config = { baseUrl: 'http://host.docker.internal:8299', token: 'tok-123' };

  it('PUT 到 /network/interfaces/<iface>/config，iface 做 URL 编码', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    let capturedBody = '';
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method || '';
      capturedBody = String(init?.body || '');
      return new Response(JSON.stringify({ ok: true, rollback_seconds: 30 }), { status: 202 });
    }) as typeof fetch;

    const result = await applyIpConfig(
      config, 'eth 0/1', { ipv4: { method: 'auto' }, ipv6: { method: 'auto' } }, fakeFetch,
    );
    expect(result.rollback_seconds).toBe(30);
    expect(capturedUrl).toBe('http://host.docker.internal:8299/network/interfaces/eth%200%2F1/config');
    expect(capturedMethod).toBe('PUT');
    expect(JSON.parse(capturedBody)).toEqual({ ipv4: { method: 'auto' }, ipv6: { method: 'auto' } });
  });
});

describe('getFallback', () => {
  const config = { baseUrl: 'http://host.docker.internal:8299', token: 'tok-123' };

  it('透传 fallback 字段', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({
      ok: true, fallback: { interface: 'enP8p1s0', address: '10.250.100.1', prefix: 24, reachable: false },
    }), { status: 200 })) as typeof fetch;
    const result = await getFallback(config, fakeFetch);
    expect(result).toEqual({ interface: 'enP8p1s0', address: '10.250.100.1', prefix: 24, reachable: false });
  });

  it('没走 provisioning 的设备返回 null，不抛异常', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ ok: true, fallback: null }), { status: 200 })) as typeof fetch;
    expect(await getFallback(config, fakeFetch)).toBeNull();
  });
});

describe('wifiConnect', () => {
  const config = { baseUrl: 'http://host.docker.internal:8299', token: 'tok-123' };

  it('POST body 带 ssid/password/hidden', async () => {
    let capturedBody = '';
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = String(init?.body || '');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    await wifiConnect(config, 'wlan0', 'MyWiFi', 'secret123', true, fakeFetch);
    expect(JSON.parse(capturedBody)).toEqual({ ssid: 'MyWiFi', password: 'secret123', hidden: true });
  });
});

describe('系统日期时间', () => {
  const config = { baseUrl: 'http://helper', token: 'tok' };
  const time = { epoch_ms: 1791525000000, timezone: 'Asia/Shanghai', ntp_enabled: true,
    ntp_synchronized: false, manually_set: false, valid: true, min_valid_epoch_ms: 1767225600000, ntp_servers: [] };

  it('读取时间状态', async () => {
    const { getSystemTime } = await import('../services/osHelperClient.js');
    let url = '';
    const fakeFetch = (async (u: string) => {
      url = u;
      return new Response(JSON.stringify({ ok: true, time }), { status: 200 });
    }) as typeof fetch;
    expect(await getSystemTime(config, fakeFetch)).toEqual(time);
    expect(url).toBe('http://helper/system/time');
  });

  it('校时：PUT epoch_ms，返回重启了哪些服务', async () => {
    const { setSystemTime } = await import('../services/osHelperClient.js');
    let method = '';
    let body = '';
    const fakeFetch = (async (_u: string, init?: RequestInit) => {
      method = init?.method ?? '';
      body = String(init?.body);
      return new Response(JSON.stringify({ ok: true, time, restarted: ['录像服务'] }), { status: 200 });
    }) as typeof fetch;
    const r = await setSystemTime(config, 1791600000000, fakeFetch);
    expect(method).toBe('PUT');
    expect(JSON.parse(body)).toEqual({ epoch_ms: 1791600000000 });
    expect(r.restarted).toEqual(['录像服务']);
  });

  it('对时服务器：PUT servers，错误文本透传', async () => {
    const { setNtpServers } = await import('../services/osHelperClient.js');
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: '对时服务器地址无效：x y' }), { status: 400 })) as typeof fetch;
    await expect(setNtpServers(config, ['x y'], fakeFetch)).rejects.toThrow('对时服务器地址无效');
  });
});
