// SRS HTTP API 客户端
// 设计：
//   1. 调用 SRS 原生 HTTP API（端口 1985）
//   2. 1.5s TTL 内存缓存（Phase 5 轮询场景去重）
//   3. SRS 不可达时优雅降级（返回空 + srsOnline=false），绝不抛错
//   4. streams 响应结构：{ code, streams: [...] } — 顶层不在 data 下（已实证）

export interface SrsStream {
  name: string;
  app: string;
  publish: { active: boolean; cid?: string; ip?: string };
  clients: number;
  // ⚠️ SRS 真实返回是嵌套对象，不是扁平数字（曾错写成 kb_ps，导致码率全线失效）：
  // recv_30s = 推流入向码率（摄像头/OBS 推上来的编码码率，无观众也非零）
  // send_30s = 播放出向码率总和（受观看人数影响，0 观众时为 0）
  kbps?: { recv_30s?: number; send_30s?: number };
  vhost?: string;
  // 实测：H.264 为 "H264"，H.265 为 "HEVC"（SRS 7.0.162，2026-09-29）。消费方仍按
  // 不区分大小写的宽松匹配（/hevc|h\.?265/i），不假设只有这两种写法。
  // level 实测是字符串（"5.1"），老版本曾见数字；消费方统一 String() 后再用
  video?: { codec?: string; profile?: string; level?: string | number; width?: number; height?: number };
  [key: string]: any;
}

export interface SrsStreamsResponse {
  code: number;
  server: string;
  service: string;
  pid: string;
  streams: SrsStream[];
}

export interface SrsClientOptions {
  apiHost: string;   // e.g. "127.0.0.1:1985"
  cacheTtlMs?: number;
  timeoutMs?: number;
}

/** rtmp→WebRTC 的 H.265 从 SRS 7.0.33 起才支持（PR #4289）；版本读不到按不支持处理 */
export function supportsRtcHevc(version: string | null): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!m) return false;
  const [major, minor, rev] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (major !== 7) return major > 7;
  return minor > 0 || rev >= 33;
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export class SrsClient {
  private apiBase: string;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;

  private streamsCache: CacheEntry<SrsStream[]> | null = null;
  private inflightStreams: Promise<SrsStream[]> | null = null;

  constructor(opts: SrsClientOptions) {
    this.apiBase = `http://${opts.apiHost}/api/v1`;
    this.cacheTtlMs = opts.cacheTtlMs ?? 1500;
    this.timeoutMs = opts.timeoutMs ?? 3000;
  }

  /**
   * 获取所有流列表（带缓存 + 请求合并）
   * SRS 不可达时返回空数组（降级），绝不抛错
   */
  async listStreams(): Promise<SrsStream[]> {
    const now = Date.now();

    // 缓存命中
    if (this.streamsCache && this.streamsCache.expiresAt > now) {
      return this.streamsCache.data;
    }

    // 已有进行中的请求，合并（避免多个并发请求打到 SRS）
    if (this.inflightStreams) {
      return this.inflightStreams;
    }

    // 发起新请求
    this.inflightStreams = this.fetchStreams()
      .then(streams => {
        this.streamsCache = {
          data: streams,
          expiresAt: Date.now() + this.cacheTtlMs,
        };
        return streams;
      })
      .finally(() => {
        this.inflightStreams = null;
      });

    return this.inflightStreams;
  }

  /**
   * 查单个流（基于 listStreams 过滤，不额外发请求）
   */
  async getStream(app: string, name: string): Promise<SrsStream | null> {
    const streams = await this.listStreams();
    return streams.find(s => s.app === app && s.name === name) ?? null;
  }

  /**
   * 检查 SRS 是否在线
   * 注意：listStreams 降级时空数组 = SRS 不可达，所以不能用 Array.isArray 判断
   * 我们用独立的 online 标记
   */
  private online = false;

  async isOnline(): Promise<boolean> {
    // 触发一次查询以刷新状态
    await this.listStreams();
    return this.online;
  }

  private versionCache: CacheEntry<string | null> | null = null;

  /**
   * SRS 实时版本（/api/v1/versions 的 data.version，如 "7.0.162"），缓存 60s。
   * 不可达返回 null，绝不抛错。取代设置里写死的 srsVersion 展示值。
   */
  async getVersion(): Promise<string | null> {
    const now = Date.now();
    if (this.versionCache && this.versionCache.expiresAt > now) return this.versionCache.data;
    let version: string | null = null;
    try {
      const res = await fetch(`${this.apiBase}/versions`, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'Accept': 'application/json' },
      });
      if (res.ok) {
        const body = (await res.json()) as { code?: number; data?: { version?: unknown } };
        if (body.code === 0 && typeof body.data?.version === 'string') version = body.data.version;
      }
    } catch {
      version = null;
    }
    // 读不到只短缓存，SRS 恢复后尽快反映
    this.versionCache = { data: version, expiresAt: now + (version ? 60_000 : 5_000) };
    return version;
  }

  // ---- 低级 ----

  private async fetchStreams(): Promise<SrsStream[]> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const res = await fetch(`${this.apiBase}/streams/`, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });

      clearTimeout(timer);

      if (!res.ok) {
        console.warn(`[srsClient] /streams HTTP ${res.status}`);
        // 回归：此前只有网络异常和 code!==0 两个分支会把 online 置 false，
        // 唯独这个"HTTP 状态码非 2xx"分支漏了——如果上一次成功请求已经把
        // online 置为 true，这次降级到空数组时 isOnline() 会继续返回 true，
        // 跟"当前这次探测其实拿到了空列表"的真实情况不一致（审计发现）。
        this.online = false;
        return [];
      }

      const body = (await res.json()) as SrsStreamsResponse;
      if (body.code !== 0) {
        console.warn(`[srsClient] /streams code=${body.code}`);
        this.online = false;
        return [];
      }

      this.online = true;
      return body.streams || [];
    } catch (e) {
      const err = e as Error;
      // 超时或网络错误：降级为空
      this.online = false;
      if (err.name === 'AbortError') {
        console.warn('[srsClient] /streams timeout');
      } else {
        console.warn(`[srsClient] /streams 失败: ${err.message}`);
      }
      return [];
    }
  }

  /**
   * 手动清缓存（测试用 / 配置变更）
   */
  clearCache(): void {
    this.streamsCache = null;
  }

  /**
   * 更新 API host（运行时配置变更用）
   */
  setApiHost(host: string): void {
    this.apiBase = `http://${host}/api/v1`;
    this.streamsCache = null;
    this.versionCache = null;
    this.inflightStreams = null;
  }
}
