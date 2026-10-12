import { describe, it, expect } from 'vitest';
import {
  isRestartableService,
  RESTARTABLE_SERVICES,
  restartHelperConfigFromEnv,
  triggerRestart,
} from '../services/restartHelperClient.js';

describe('isRestartableService / RESTARTABLE_SERVICES', () => {
  it('只认 ai-service 和 recorder 两个目标', () => {
    expect(RESTARTABLE_SERVICES).toEqual(['ai-service', 'recorder']);
    expect(isRestartableService('ai-service')).toBe(true);
    expect(isRestartableService('recorder')).toBe(true);
  });

  it('backend/srs 不在允许列表——它们的配置全部热生效，不需要走重启', () => {
    expect(isRestartableService('backend')).toBe(false);
    expect(isRestartableService('srs')).toBe(false);
  });

  it('任意/非法值一律拒绝', () => {
    expect(isRestartableService('../etc/passwd')).toBe(false);
    expect(isRestartableService('')).toBe(false);
    expect(isRestartableService(123)).toBe(false);
    expect(isRestartableService(null)).toBe(false);
  });
});

describe('restartHelperConfigFromEnv', () => {
  it('两个环境变量都配置时返回 config，baseUrl 去掉末尾斜杠', () => {
    const cfg = restartHelperConfigFromEnv({
      RESTART_HELPER_URL: 'http://host.docker.internal:8199/',
      RESTART_HELPER_TOKEN: 'tok-123',
    } as NodeJS.ProcessEnv);
    expect(cfg).toEqual({ baseUrl: 'http://host.docker.internal:8199', token: 'tok-123' });
  });

  it('缺 URL 或缺 token 时返回 null（功能整体禁用，不是报错）', () => {
    expect(restartHelperConfigFromEnv({ RESTART_HELPER_TOKEN: 'tok' } as NodeJS.ProcessEnv)).toBeNull();
    expect(restartHelperConfigFromEnv({ RESTART_HELPER_URL: 'http://x' } as NodeJS.ProcessEnv)).toBeNull();
    expect(restartHelperConfigFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('triggerRestart', () => {
  const config = { baseUrl: 'http://host.docker.internal:8199', token: 'tok-123' };

  it('成功时返回 ok:true，请求带上 Bearer token 和正确路径', async () => {
    let capturedUrl = '';
    let capturedHeaders: HeadersInit | undefined;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const result = await triggerRestart(config, 'ai-service', fakeFetch);
    expect(result).toEqual({ ok: true });
    expect(capturedUrl).toBe('http://host.docker.internal:8199/restart/ai-service');
    expect((capturedHeaders as Record<string, string>).Authorization).toBe('Bearer tok-123');
  });

  it('助手返回 ok:false 时透传 error 文本', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: 'target 不在允许列表: backend' }), { status: 400 })) as typeof fetch;

    const result = await triggerRestart(config, 'ai-service', fakeFetch);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('target 不在允许列表: backend');
  });

  it('网络异常时返回 ok:false 并带错误信息，不抛出未捕获异常', async () => {
    const fakeFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;

    const result = await triggerRestart(config, 'recorder', fakeFetch);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('超时（AbortError）时返回带"超时"字样的错误', async () => {
    const fakeFetch = (async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }) as typeof fetch;

    const result = await triggerRestart(config, 'recorder', fakeFetch);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('超时');
  });
});

describe('getShutdownStatus', () => {
  const config = { baseUrl: 'http://helper', token: 'tok' };

  it('查询最近一次关机序列的结果（失败原因与已恢复的服务）', async () => {
    const { getShutdownStatus } = await import('../services/restartHelperClient.js');
    let url = '';
    let auth = '';
    const fetchImpl = (async (u: string, init: RequestInit) => {
      url = u;
      auth = (init.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({
        ok: true,
        status: { state: 'failed', error: '第 2 步失败；关机已中止，已恢复：AI 识别服务、录像服务', restored: ['AI 识别服务', '录像服务'], restoreFailed: [] },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const status = await getShutdownStatus(config, fetchImpl);
    expect(url).toBe('http://helper/shutdown/status');
    expect(auth).toBe('Bearer tok');
    expect(status.state).toBe('failed');
    expect(status.restored).toEqual(['AI 识别服务', '录像服务']);
  });

  it('助手不可达时抛错（由调用方决定怎么展示）', async () => {
    const { getShutdownStatus } = await import('../services/restartHelperClient.js');
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(getShutdownStatus(config, fetchImpl)).rejects.toThrow();
  });
});
