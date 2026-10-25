// 通道服务：业务逻辑层
// 职责：通道 CRUD + SRS 状态聚合 + URL 生成 + streamName 唯一性校验

import crypto from 'node:crypto';
import { normalizeInput, hasVideo, safeChannel } from './ingestPolicy.js';
import type { PgConfigStore } from '../store/pgStore.js';
import { JsonStore } from '../store/jsonStore.js';
import { SrsClient } from './srsClient.js';
import {
  Channel,
  ChannelWithStatus,
  ChannelStatus,
  UpstreamProtocol,
  DownstreamProtocol,
  AppSettings,
} from '../types/channel.js';

export interface ChannelStoreData {
  channels: Channel[];
}

export interface CreateChannelInput {
  name: string;
  upstreamProtocol: UpstreamProtocol;
  streamName?: string;     // 不传则自动生成
  downstreamProtocols: DownstreamProtocol[];
  app?: string;
  primaryProtocol?: DownstreamProtocol;
  remark?: string;
  rtspUrl?: string;
  rtspTransport?: 'tcp' | 'udp';
  inputUsername?: string;
  inputPassword?: string;
  inputEnabled?: boolean;
}

export interface UpdateChannelInput {
  name?: string;
  upstreamProtocol?: UpstreamProtocol;
  streamName?: string;
  downstreamProtocols?: DownstreamProtocol[];
  app?: string;
  primaryProtocol?: DownstreamProtocol;
  remark?: string;
  rtspUrl?: string;
  rtspTransport?: 'tcp' | 'udp';
  inputUsername?: string;
  inputPassword?: string;
  inputEnabled?: boolean;
}

export interface ChannelServiceOptions {
  store: JsonStore<ChannelStoreData>;
  srsClient: SrsClient;
  settingsStore: JsonStore<AppSettings>;
  defaultApp?: string;
  secrets?: () => Pick<PgConfigStore, 'setSecret' | 'getSecret' | 'deleteSecret'> | null;
  stopPublisher?: (id: string) => Promise<void>;
  withPublisherLock?: <T>(id: string, action: () => Promise<T>) => Promise<T>;
  protectedIdentity?: (id: string) => Promise<boolean>;
}

export class ChannelService {
  private readonly store: JsonStore<ChannelStoreData>;
  private readonly srsClient: SrsClient;
  private readonly settingsStore: JsonStore<AppSettings>;
  private readonly defaultApp: string;
  private readonly secrets: ChannelServiceOptions['secrets'];
  private readonly stopPublisher: ChannelServiceOptions['stopPublisher'];
  private readonly withPublisherLock: ChannelServiceOptions['withPublisherLock'];
  private readonly protectedIdentity: ChannelServiceOptions['protectedIdentity'];
  private readonly videoProgress = new Map<string, { frames: number; cid?: string; at: number }>();

  constructor(opts: ChannelServiceOptions) {
    this.store = opts.store;
    this.srsClient = opts.srsClient;
    this.settingsStore = opts.settingsStore;
    this.defaultApp = opts.defaultApp ?? 'live';
    this.secrets = opts.secrets;
    this.stopPublisher = opts.stopPublisher;
    this.withPublisherLock = opts.withPublisherLock;
    this.protectedIdentity = opts.protectedIdentity;
  }

  /** 请求值在协议列表里则用请求值；否则优先 flv，否则取第一个 */
  private resolvePrimary(
    protocols: DownstreamProtocol[],
    requested?: DownstreamProtocol,
  ): DownstreamProtocol {
    if (requested && protocols.includes(requested)) return requested;
    return (protocols.includes('flv') ? 'flv' : protocols[0]) as DownstreamProtocol;
  }

  // ---- 列表（带 SRS 状态聚合）----

  async listChannels(): Promise<ChannelWithStatus[]> {
    const { channels } = await this.store.read();
    const normalized = channels.map(ch => this.normalizeChannel(ch));
    const streams = await this.srsClient.listStreams();
    const srsOnline = await this.srsClient.isOnline();

    return normalized.map(ch => this.mergeStatus(ch, streams, srsOnline));
  }

  /**
   * 列表接口专用：带上每条通道的推流/播放地址。
   * ⚠️ 只读一次 settings，循环内用同步纯函数拼地址，避免 N 条通道 N 次读盘。
   */
  async listChannelsWithUrls(
    host: string,
  ): Promise<Array<ChannelWithStatus & { urls: { push?: Record<string, string>; play: Record<string, string> } }>> {
    const channels = await this.listChannels();
    const settings = await this.settingsStore.read();
    return channels.map(ch => ({ ...ch, urls: this.buildStreamUrls(ch, host, settings) }));
  }

  // ---- 详情 ----

  async getChannel(id: string): Promise<ChannelWithStatus | null> {
    const { channels } = await this.store.read();
    const ch = channels.find(c => c.id === id) ?? null;
    if (!ch) return null;

    const normalized = this.normalizeChannel(ch);
    const streams = await this.srsClient.listStreams();
    const srsOnline = await this.srsClient.isOnline();
    return this.mergeStatus(normalized, streams, srsOnline);
  }

  // ---- 创建 ----

  async createChannel(input: CreateChannelInput): Promise<ChannelWithStatus> {
    const normalized = normalizeInput(input);
    const streamName = input.streamName ?? this.generateStreamName(input.name);

    const now = Date.now();
    const channel: Channel = {
      id: this.genId(),
      name: input.name.trim(),
      upstreamProtocol: input.upstreamProtocol,
      streamName,
      downstreamProtocols: input.downstreamProtocols,
      app: input.app?.trim() || undefined,
      primaryProtocol: this.resolvePrimary(input.downstreamProtocols, input.primaryProtocol),
      remark: input.remark?.trim() || undefined,
      rtspUrl: input.rtspUrl?.trim() || undefined,
      rtspTransport: input.rtspTransport ?? 'tcp',
      inputEnabled: input.inputEnabled ?? true,
      inputGeneration: crypto.randomUUID(),
      inputUsername: input.inputUsername,
      createdAt: now,
      updatedAt: now,
    };

    // 写库（锁内校验唯一）
    if (normalized.secret) {
      const secrets = this.secrets?.();
      if (!secrets) throw new Error('安全凭据存储尚未就绪');
      channel.sourceRef = `backend/ingest/${channel.id}/${channel.inputGeneration}`;
      await secrets.setSecret(channel.sourceRef, normalized.secret);
      channel.rtspUrl = normalized.publicUrl;
      channel.inputCredentialSet = !!new URL(normalized.secret).password;
    }
    let data: ChannelStoreData;
    try { data = await this.store.mutate(d => {
      // streamName 唯一性校验（同 app 下不重复）
      const exists = d.channels.some(c => c.streamName === streamName);
      if (exists) {
        const err = new Error(`streamName 已存在: ${streamName}`);
        (err as any).code = 'STREAM_NAME_DUPLICATE';
        throw err;
      }
      d.channels.push(channel);
    }); } catch (e) {
      if (channel.sourceRef) await this.secrets?.()?.deleteSecret(channel.sourceRef);
      throw e;
    }

    const ch = data.channels.find(c => c.id === channel.id)!;
    // 返回带状态
    const streams = await this.srsClient.listStreams();
    const srsOnline = await this.srsClient.isOnline();
    return this.mergeStatus(ch, streams, srsOnline);
  }

  // ---- 更新 ----

  async updateChannel(id: string, input: UpdateChannelInput): Promise<ChannelWithStatus> {
    return this.withPublisherLock ? this.withPublisherLock(id, () => this.updateChannelLocked(id, input)) : this.updateChannelLocked(id, input);
  }

  private async updateChannelLocked(id: string, input: UpdateChannelInput): Promise<ChannelWithStatus> {
    const old = (await this.store.read()).channels.find(c => c.id === id);
    if (!old) throw Object.assign(new Error('通道不存在'), { code: 'NOT_FOUND' });
    const identityChanged = (['upstreamProtocol','app','streamName'] as const)
      .some(key => input[key] !== undefined && input[key] !== old[key]);
    if (identityChanged && await this.protectedIdentity?.(id))
      throw Object.assign(new Error('国标输入的发布身份由设备目录管理；可修改名称，启停请使用国标接入面板'), {code:'CONFLICT'});
    const protocol = input.upstreamProtocol ?? old.upstreamProtocol;
    const reconnect = ['upstreamProtocol', 'streamName', 'app', 'rtspUrl', 'rtspTransport', 'inputUsername', 'inputPassword', 'inputEnabled']
      .some(key => (input as any)[key] !== undefined && (input as any)[key] !== (old as any)[key]);
    let normalized: ReturnType<typeof normalizeInput> = {};
    let sourceRef: string | undefined;
    const generation = reconnect ? crypto.randomUUID() : old.inputGeneration;
    if (reconnect && old.upstreamProtocol === 'webrtc') await this.stopPublisher?.(id);
    if (protocol === 'rtsp' && reconnect) {
      let url = input.rtspUrl ?? old.rtspUrl;
      if (old.sourceRef) {
        const previous = await this.secrets?.()?.getSecret(old.sourceRef);
        if (!previous) throw new Error('原摄像头凭据无法读取，请恢复凭据存储后重试');
        const target = new URL(url!);
        const credentials = new URL(previous);
        // 编辑时留空保留原值；地址中显式填写的新凭据优先。
        if (!target.username && !input.inputUsername) target.username = credentials.username;
        if (!target.password && !input.inputPassword) target.password = credentials.password;
        url = target.toString();
      }
      normalized = normalizeInput({ ...input, inputUsername: input.inputUsername || undefined,
        inputPassword: input.inputPassword || undefined, upstreamProtocol: protocol, rtspUrl: url });
      const secrets = this.secrets?.();
      if (!secrets) throw new Error('安全凭据存储尚未就绪');
      sourceRef = `backend/ingest/${id}/${generation}`;
      await secrets.setSecret(sourceRef, normalized.secret!);
    } else if (protocol !== 'rtsp') normalizeInput({ ...input, upstreamProtocol: protocol });
    let data: ChannelStoreData;
    try { data = await this.store.mutate(d => {
      const idx = d.channels.findIndex(c => c.id === id);
      if (idx === -1) {
        const err = new Error('通道不存在');
        (err as any).code = 'NOT_FOUND';
        throw err;
      }

      const ch = d.channels[idx];
      if (ch.inputGeneration !== old.inputGeneration) throw Object.assign(new Error('配置已变化，请刷新后重试'), { code: 'CONFLICT' });

      // 若改 streamName，校验唯一性（排除自己）
      if (input.streamName && input.streamName !== ch.streamName) {
        const dup = d.channels.some(c => c.streamName === input.streamName && c.id !== id);
        if (dup) {
          const err = new Error(`streamName 已存在: ${input.streamName}`);
          (err as any).code = 'STREAM_NAME_DUPLICATE';
          throw err;
        }
        ch.streamName = input.streamName;
      }

      if (input.name !== undefined) ch.name = input.name.trim();
      if (input.upstreamProtocol !== undefined) ch.upstreamProtocol = input.upstreamProtocol;
      if (input.downstreamProtocols !== undefined) ch.downstreamProtocols = input.downstreamProtocols;
      if (input.app !== undefined) ch.app = input.app.trim() || undefined;
      // primary 只要「本次传了 primary」或「本次改了 protocols 导致原 primary 可能失效」就要重算
      if (input.primaryProtocol !== undefined || input.downstreamProtocols !== undefined) {
        ch.primaryProtocol = this.resolvePrimary(
          ch.downstreamProtocols,
          input.primaryProtocol ?? ch.primaryProtocol,
        );
      }
      if (input.remark !== undefined) ch.remark = input.remark.trim() || undefined;
      if (input.rtspUrl !== undefined) ch.rtspUrl = input.rtspUrl.trim() || undefined;
      if (input.rtspTransport !== undefined) ch.rtspTransport = input.rtspTransport;
      if (input.inputEnabled !== undefined) ch.inputEnabled = input.inputEnabled;
      if (input.inputUsername) ch.inputUsername = input.inputUsername;
      ch.inputGeneration = generation;
      if (sourceRef) {
        ch.sourceRef = sourceRef;
        ch.rtspUrl = normalized.publicUrl;
        ch.inputCredentialSet = !!new URL(normalized.secret!).password;
      }
      if (protocol !== 'rtsp') {
        delete ch.rtspUrl; delete ch.sourceRef; delete ch.inputUsername; delete ch.inputCredentialSet;
      }

      ch.updatedAt = Date.now();
    }); } catch (e) { if (sourceRef) await this.secrets?.()?.deleteSecret(sourceRef); throw e; }
    // Keep the committed configuration successful even if orphan cleanup fails.
    if (old.sourceRef && (sourceRef || protocol !== 'rtsp')) await this.secrets?.()?.deleteSecret(old.sourceRef).catch(() => {});

    const ch = data.channels.find(c => c.id === id)!;
    const streams = await this.srsClient.listStreams();
    const srsOnline = await this.srsClient.isOnline();
    return this.mergeStatus(ch, streams, srsOnline);
  }

  // ---- 删除 ----

  /** 导入已提交后，只清理不再被当前通道引用的拉流凭据。 */
  async cleanupDiscardedInputSecrets(previous: Channel[]): Promise<void> {
    const current = await this.store.read();
    const activeRefs = new Set(current.channels.map(c => c.sourceRef).filter(Boolean));
    const secrets = this.secrets?.();
    if (!secrets) return;
    for (const ref of new Set(previous.map(c => c.sourceRef).filter(Boolean))) {
      if (!activeRefs.has(ref)) await secrets.deleteSecret(ref!);
    }
  }

  async deleteChannel(id: string): Promise<boolean> {
    return this.withPublisherLock ? this.withPublisherLock(id, () => this.deleteChannelLocked(id)) : this.deleteChannelLocked(id);
  }

  private async deleteChannelLocked(id: string): Promise<boolean> {
    const old = (await this.store.read()).channels.find(c => c.id === id);
    if (old?.upstreamProtocol === 'webrtc') await this.stopPublisher?.(id);
    let found = false;
    let ref: string | undefined;
    await this.store.mutate(d => {
      const idx = d.channels.findIndex(c => c.id === id);
      if (idx !== -1) {
        ref = d.channels[idx]!.sourceRef;
        d.channels.splice(idx, 1);
        found = true;
      }
    });
    if (ref) await this.secrets?.()?.deleteSecret(ref).catch(() => {});
    if (found) await this.secrets?.()?.deleteSecret(`backend/ingest-publish/${id}`).catch(() => {});
    this.videoProgress.delete(id);
    return found;
  }

  // ---- URL 生成（BFF 端生成，依据请求 host + 系统设置里的协议主机名覆盖）----

  /**
   * 生成该通道的所有协议推流/播放地址（纯函数，不读盘，供批量场景复用）
   * @param host 用户访问的 host（含端口），用于生成用户可达的 URL（覆盖设置为空时的兜底）
   * @param settings 当前系统设置（协议专属主机名覆盖）
   */
  private buildStreamUrls(
    channel: Channel,
    host: string,
    settings: AppSettings,
  ): { push?: Record<string, string>; play: Record<string, string> } {
    const hostname = host.split(':')[0]; // 去掉端口（SRS 各协议用各自端口）
    // 覆盖值带 ':' 就整体当 host:port 用；不带就当纯 hostname，照旧拼默认端口
    const withPort = (override: string | undefined, defaultPort: number): string =>
      override ? (override.includes(':') ? override : `${override}:${defaultPort}`) : `${hostname}:${defaultPort}`;
    const rtmpHost = withPort(settings.srsRtmpHost, 1935);
    // Public browser media always passes the console's authentication gateway.
    const httpHost = host;
    const srtHost = withPort(settings.srsSrtHost, 10080);
    const rtcHost = settings.srsRtcHost || hostname;
    const app = channel.app || this.defaultApp;
    const { streamName, upstreamProtocol } = channel;

    const play: Record<string, string> = {};

    for (const proto of channel.downstreamProtocols) {
      switch (proto) {
        case 'flv':
          play.flv = `http://${httpHost}/media/${app}/${streamName}.flv`;
          break;
        case 'hls':
          play.hls = `http://${httpHost}/media/${app}/${streamName}.m3u8`;
          break;
        case 'webrtc':
          play.webrtc = `webrtc://${rtcHost}/${app}/${streamName}`;
          break;
        case 'rtmp':
          play.rtmp = `rtmp://${rtmpHost}/${app}/${streamName}`;
          break;
        case 'srt':
          // 拉流用 m=request，与下方推流的 m=publish 区分
          play.srt = `srt://${srtHost}?streamid=#!::r=${app}/${streamName},m=request`;
          break;
      }
    }

    const push: Record<string, string> = {};
    switch (upstreamProtocol) {
      case 'rtmp':
        push.rtmp = `rtmp://${rtmpHost}/${app}/${streamName}`;
        break;
      case 'srt':
        push.srt = `srt://${srtHost}?streamid=#!::r=${app}/${streamName},m=publish`;
        break;
      case 'webrtc':
        push.webrtc = `http://${host}/ingest/whip/${channel.id}`;
        break;
      case 'rtsp':
        // RTSP 是拉流（SRS 从摄像头拉），不是推流地址
        push.rtsp = channel.rtspUrl || '';
        break;
    }

    return { push, play };
  }

  /** 单条通道场景（create/detail/update 路由用）：读一次 settings 再拼地址 */
  async getStreamUrls(
    channel: Channel,
    host: string,
  ): Promise<{ push?: Record<string, string>; play: Record<string, string> }> {
    const settings = await this.settingsStore.read();
    return this.buildStreamUrls(channel, host, settings);
  }

  // ---- 内部 ----

  /**
   * 读取后兜底：旧格式或损坏数据可能缺失 downstreamProtocols，
   * 这里补齐，防止下游 for...of / .includes 直接炸 500。
   * 只做读取时的 normalize，不改写存储层。
   */
  private normalizeChannel(ch: Channel): Channel {
    if (!Array.isArray(ch.downstreamProtocols)) {
      return { ...ch, downstreamProtocols: ['flv'] };
    }
    return ch;
  }

  private mergeStatus(ch: Channel, streams: any[], srsOnline: boolean): ChannelWithStatus {
    // ⚠️ 必须按 per-channel app 匹配，不能固定用 this.defaultApp——
    // 否则自定义了 app 的通道永远匹配不到 SRS 流，误判永久离线、码率永远空。
    const stream = streams.find(s => s.app === (ch.app || this.defaultApp) && s.name === ch.streamName);
    let online = srsOnline && hasVideo(stream);
    if (online && typeof stream.frames === 'number') {
      const prior = this.videoProgress.get(ch.id);
      const cid = stream.publish?.cid;
      if (!prior || prior.frames !== stream.frames || prior.cid !== cid) {
        this.videoProgress.set(ch.id, { frames: stream.frames, cid, at: performance.now() });
      } else if (performance.now() - prior.at > 15_000) online = false;
    }

    const status: ChannelStatus = {
      online,
      clients: stream?.clients ?? 0,
      bitrate: stream?.kbps?.recv_30s,
      srsOnline,
      connectionActive: !!stream?.publish?.active,
      inputState: online ? 'streaming' : stream?.publish?.active ? 'waiting-video' : 'waiting-source',
      videoCodec: stream?.video?.codec,
      videoLevel: stream?.video?.level === undefined ? undefined : String(stream.video.level),
      videoWidth: stream?.video?.width,
      videoHeight: stream?.video?.height,
    };

    return { ...safeChannel(ch), status };
  }

  private genId(): string {
    // 用 crypto.randomUUID，少一个依赖
    return crypto.randomUUID();
  }

  private generateStreamName(name: string): string {
    // 从名称派生：小写字母数字下划线 + 短随机后缀
    const base = name.toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 20);
    const suffix = crypto.randomBytes(3).toString('hex');
    return base ? `${base}_${suffix}` : `stream_${suffix}`;
  }
}
