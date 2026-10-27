import { z } from 'zod';
import { OnvifStore, OnvifError } from '../store/onvifStore.js';
import type { Channel, OnvifBinding } from '../types/channel.js';
import { sameOnvifBinding } from '../types/channel.js';
import type { ChannelService, CreateChannelInput, UpdateChannelInput } from './channelService.js';

export const onvifBindingSchema = z
  .object({
    deviceId: z.string().uuid(),
    deviceVersion: z.number().int().min(1),
    service: z.enum(['media1', 'media2']),
    profileToken: z.string().min(1).max(256),
    videoSource: z.string().min(1).max(256),
  })
  .strict();
export const profileSchema = z.object({
  service: z.enum(['media1', 'media2']),
  token: z.string().min(1).max(256),
  name: z.string().max(65536),
  videoSource: z.string().min(1).max(256),
  videoCodec: z.string().max(64),
  audioCodec: z.string().max(64),
  width: z.number().int().min(0).max(32768),
  height: z.number().int().min(0).max(32768),
  fps: z.number().min(0).max(1000),
});
export const capabilitiesSchema = z.object({
  manufacturer: z.string().max(65536),
  model: z.string().max(65536),
  firmware: z.string().max(65536),
  serial: z.string().max(65536),
  hardwareID: z.string().max(65536),
  clockOffsetSeconds: z.number().int(),
  clockVerified: z.boolean(),
  profiles: z.array(profileSchema).max(256),
  warnings: z.array(z.string().max(100)).max(32),
});
const resolvedSchema = z.object({
  uri: z.string().max(2048).url(),
  timeoutSeconds: z.number().int().min(-1).max(31536000),
  invalidAfterConnect: z.boolean(),
  invalidAfterReboot: z.boolean(),
  profile: profileSchema,
});
const permanent = new Set([
  'profile_not_found',
  'device_not_found',
  'authentication_failed',
  'address_not_allowed',
  'service_host_changed',
  'media_host_changed',
  'unsupported_media_uri',
]);
export class OnvifManager {
  private pending: Promise<void> | null = null;
  private tasks = new Map<string, { next: number; generation?: string; error?: string }>();
  private configurationEnabled = false;
  private state: Record<string, unknown> = { state: 'waiting_configuration' };
  constructor(
    public store: OnvifStore,
    private channels: ChannelService,
  ) {}
  status() {
    return {
      ...this.state,
      channels: Object.fromEntries([...this.tasks].map(([id, v]) => [id, { error: v.error }])),
    };
  }
  async preparePtz(binding: OnvifBinding) {
    const { record, device } = await this.store.device(binding.deviceId);
    if (Number(record.version) !== binding.deviceVersion) throw new OnvifError('device_configuration_changed',409);
    return this.call('/v1/ptz/prepare',{device,service:binding.service,token:binding.profileToken,videoSource:binding.videoSource});
  }
  async ptz(path:string,body:unknown) {
    if (!['command','status','presets','preset-save','preset-remove'].includes(path)) throw new OnvifError('ptz_invalid_operation');
    return this.call(`/v1/ptz/${path}`,body);
  }
  inputAllowed(channel: Channel) {
    return (
      !channel.onvif ||
      (this.configurationEnabled && !permanent.has(this.tasks.get(channel.id)?.error ?? ''))
    );
  }
  private async call(path: string, body?: unknown, method = 'POST') {
    const { settings } = await this.store.settings(),
      token = await this.store.pg.getSecret('onvif/service-token');
    if (!token) throw new OnvifError('service_credential_missing', 503);
    let response: Response;
    try {
      response = await fetch(settings.serviceUrl.replace(/\/$/, '') + path, {
        method,
        headers: { 'X-Service-Token': token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(path.startsWith('/v1/ptz/')?10000:48000),
      });
    } catch {
      throw new OnvifError('control_service_unavailable', 503);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new OnvifError('control_service_unavailable', 503);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4 * 1024 * 1024) throw new OnvifError('response_too_large', 503);
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    let result: any;
    try {
      result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new OnvifError('invalid_service_response', 503);
    }
    if (!response.ok)
      throw new OnvifError(
        typeof result.error === 'string' && /^[a-z_]{1,80}$/.test(result.error)
          ? result.error
          : 'control_service_unavailable',
        response.status === 429 ? 429 : 422,
      );
    return result;
  }
  async apply() {
    const { revision, settings, tokenSet } = await this.store.settings();
    this.configurationEnabled = settings.enabled;
    if (!tokenSet) {
      this.state = { state: 'waiting_configuration', desiredRevision: revision };
      return;
    }
    const applied = await this.call(
      '/v1/config',
      {
        revision,
        enabled: settings.enabled,
        policy: { allowedCIDRs: settings.allowedCIDRs, timeoutSeconds: settings.timeoutSeconds },
        interfaces: settings.interfaces,
      },
      'PUT',
    );
    if (applied.appliedRevision !== revision) throw new OnvifError('configuration_pending', 503);
    this.state = {
      state: settings.enabled ? 'running' : 'disabled',
      desiredRevision: revision,
      appliedRevision: revision,
    };
  }
  async probe(deviceId: string) {
    await this.apply();
    const { record, device } = await this.store.device(deviceId);
    try {
      const caps = capabilitiesSchema.parse(await this.call('/v1/probe', { device }));
      await this.store.recordProbe(deviceId, record.version, caps, null);
      for (const c of await this.channels.listChannels()) {
        if (c.onvif?.deviceId === deviceId) this.tasks.delete(c.id);
      }
      return { version: record.version, capabilities: caps };
    } catch (e) {
      await this.store.recordProbe(
        deviceId,
        record.version,
        null,
        e instanceof OnvifError ? e.code : 'device_probe_failed',
      );
      throw e;
    }
  }
  async discover(iface: string) {
    await this.apply();
    return z
      .object({
        items: z
          .array(
            z.object({
              epr: z.string().max(300),
              url: z.string().url().max(2048),
              scopes: z.array(z.string().max(65536)).max(32),
            }),
          )
          .max(128),
      })
      .parse(await this.call('/v1/discover', { interface: iface }));
  }
  private async source(binding: OnvifBinding) {
    const { record, device } = await this.store.device(binding.deviceId);
    if (Number(record.version) !== binding.deviceVersion)
      throw new OnvifError('device_configuration_changed', 409);
    const result = resolvedSchema.parse(
      await this.call('/v1/resolve', {
        device,
        service: binding.service,
        token: binding.profileToken,
        videoSource: binding.videoSource,
      }),
    );
    if (
      result.profile.service !== binding.service ||
      result.profile.token !== binding.profileToken ||
      result.profile.videoSource !== binding.videoSource
    )
      throw new OnvifError('profile_identity_mismatch', 503);
    if (!['H264', 'H265', 'HEVC'].includes(result.profile.videoCodec))
      throw new OnvifError('unsupported_video_codec', 422);
    // Never accept a pre-authenticated or different-host URI from a device reply.
    const uri = new URL(result.uri),
      host = new URL(device.url).hostname;
    if (
      uri.protocol !== 'rtsp:' ||
      uri.username ||
      uri.password ||
      uri.hash ||
      uri.hostname.toLowerCase() !== host.toLowerCase()
    )
      throw new OnvifError('media_host_changed', 422);
    if (
      Number((await this.store.device(binding.deviceId)).record.version) !== binding.deviceVersion
    )
      throw new OnvifError('device_configuration_changed', 409);
    return {
      result,
      input: {
        rtspUrl: uri.toString(),
        inputUsername: device.username,
        inputPassword: device.password,
        onvif: binding,
        inputAudioMode: 'auto' as const,
        rtspTransport: 'tcp' as const,
      },
    };
  }
  async saveChannel(
    binding: OnvifBinding,
    config: Omit<CreateChannelInput, 'upstreamProtocol'>,
    inputId?: string,
    expectedGeneration?: string,
  ) {
    if (inputId) {
      const old = await this.channels.getChannel(inputId);
      if (!old?.onvif) throw new OnvifError('not_an_onvif_channel', 409);
      if (!expectedGeneration) throw new OnvifError('version_conflict', 409);
      if (sameOnvifBinding(old.onvif, binding) && (!config.inputEnabled || await this.channels.hasInputSource(inputId, old.inputGeneration))) {
        await this.channels.updateChannel(inputId, { ...config, expectedGeneration });
        return { id: inputId };
      }
    }
    await this.apply();
    const { result, input } = await this.source(onvifBindingSchema.parse(binding));
    if (inputId) {
      const old = await this.channels.getChannel(inputId);
      if (!old?.onvif) throw new OnvifError('not_an_onvif_channel', 409);
      if (!expectedGeneration) throw new OnvifError('version_conflict', 409);
      await this.channels.updateChannel(inputId, { ...config, ...input, expectedGeneration });
      return { id: inputId };
    }
    const existing = (await this.channels.listChannels()).find(
      (c) =>
        c.onvif?.deviceId === binding.deviceId &&
        c.onvif.service === binding.service &&
        c.onvif.profileToken === binding.profileToken &&
        c.onvif.videoSource === binding.videoSource,
    );
    if (existing) throw new OnvifError('source_already_connected', 409);
    const created = await this.channels.createChannel({
      ...config,
      ...input,
      upstreamProtocol: 'rtsp',
    });
    this.tasks.set(created.id, {
      next: Date.now() + this.refreshAfter(result.timeoutSeconds),
      generation: created.inputGeneration,
    });
    return { id: created.id };
  }
  async connectSource(channel: Channel) {
    if (!channel.onvif || channel.inputEnabled === false)
      throw new OnvifError('source_configuration_changed', 409);
    await this.apply();
    if (!this.inputAllowed(channel)) throw new OnvifError('onvif_disabled', 409);
    try {
      const { result, input } = await this.source(channel.onvif);
      const current = await this.channels.getChannel(channel.id);
      if (
        !current ||
        current.inputEnabled === false ||
        current.inputGeneration !== channel.inputGeneration ||
        !sameOnvifBinding(current.onvif, channel.onvif)
      )
        throw new OnvifError('source_configuration_changed', 409);
      const uri = new URL(input.rtspUrl);
      uri.username = input.inputUsername;
      uri.password = input.inputPassword;
      const { settings } = await this.store.settings();
      return {
        source: uri.toString(),
        refreshAfterProbe: result.invalidAfterConnect || result.timeoutSeconds !== 0,
        allowedCIDRs: settings.allowedCIDRs,
      };
    } catch (e) {
      const error = e instanceof OnvifError ? e.code : 'control_service_unavailable';
      if (error === 'authentication_failed')
        await this.store.recordProbe(
          channel.onvif.deviceId,
          channel.onvif.deviceVersion,
          null,
          error,
        );
      this.tasks.set(channel.id, {
        next: Date.now() + 60000,
        generation: channel.inputGeneration,
        error,
      });
      throw e;
    }
  }
  private refreshAfter(seconds: number) {
    return seconds > 0 ? Math.max(5000, Math.min(300000, seconds * 500)) : 300000;
  }
  synchronize() {
    if (this.pending) return this.pending;
    this.pending = this.run()
      .catch(() => {
        this.state = { ...this.state, state: 'unavailable' };
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
  private async run() {
    await this.apply();
    if (!this.configurationEnabled) return;
    const inputs = (await this.channels.listChannels()).filter((c) => c.onvif);
    const ids = new Set(inputs.map((c) => c.id));
    for (const id of this.tasks.keys()) if (!ids.has(id)) this.tasks.delete(id);
    const due = inputs.filter(
      (c) =>
        c.inputEnabled !== false &&
        ((this.tasks.get(c.id)?.next ?? 0) <= Date.now() ||
          this.tasks.get(c.id)?.generation !== c.inputGeneration),
    );
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(2, due.length) }, async () => {
        while (index < due.length) {
          const c = due[index++]!;
          const state = this.tasks.get(c.id);
          let attemptedDeviceVersion: number | undefined;
          try {
            const { record } = await this.store.device(c.onvif!.deviceId);
            attemptedDeviceVersion = Number(record.version);
            const binding = { ...c.onvif!, deviceVersion: attemptedDeviceVersion };
            if (record.last_error === 'authentication_failed') {
              this.tasks.set(c.id, {
                next: Infinity,
                generation: c.inputGeneration,
                error: 'authentication_failed',
              });
              continue;
            }
            // Media URI lifetime governs new connections, not an established stream.
            // Refresh on a new worker connection, never interrupt a healthy stream
            // just because GetStreamUri would return a different expiring token.
            if (
              c.onvif!.deviceVersion === binding.deviceVersion &&
              !permanent.has(state?.error ?? '')
            ) {
              this.tasks.set(c.id, { next: Infinity, generation: c.inputGeneration });
              continue;
            }
            if (
              permanent.has(state?.error ?? '') &&
              c.onvif?.deviceVersion === binding.deviceVersion
            ) {
              continue;
            }
            const { result, input } = await this.source(binding);
            const uri = new URL(input.rtspUrl);
            uri.username = input.inputUsername;
            uri.password = input.inputPassword;
            let generation = c.inputGeneration;
            if (
              !(await this.channels.inputSourceMatches(c.id, c.inputGeneration, uri.toString())) ||
              c.onvif?.deviceVersion !== binding.deviceVersion
            ) {
              const changed = await this.channels.updateChannel(c.id, {
                ...input,
                expectedGeneration: c.inputGeneration,
              } as UpdateChannelInput);
              generation = changed.inputGeneration;
            }
            this.tasks.set(c.id, {
              next: Date.now() + this.refreshAfter(result.timeoutSeconds),
              generation,
            });
          } catch (e) {
            if (
              e instanceof OnvifError &&
              e.code === 'authentication_failed' &&
              attemptedDeviceVersion !== undefined
            ) {
              await this.store.recordProbe(c.onvif!.deviceId, attemptedDeviceVersion, null, e.code);
            }
            this.tasks.set(c.id, {
              next: Date.now() + 60000,
              generation: c.inputGeneration,
              error: e instanceof OnvifError ? e.code : 'control_service_unavailable',
            });
          }
        }
      }),
    );
  }
}
