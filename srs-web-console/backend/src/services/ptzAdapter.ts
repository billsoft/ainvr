import { z } from 'zod';
import { ptzCameraKey } from './ptzSources.js';
import type { Channel } from '../types/channel.js';
import type { OnvifManager } from './onvifManager.js';
import type { GB28181Sync } from './gb28181Sync.js';
import { PtzError, PtzStore } from '../store/ptzStore.js';
export const ONVIF_IDENTITY_QUERY = `SELECT d.version, EXISTS (
             SELECT 1 FROM onvif_devices other WHERE other.device_id<>d.device_id AND (
               (NULLIF(TRIM(d.epr),'') IS NOT NULL AND TRIM(other.epr)=TRIM(d.epr)) OR
               (NULLIF(TRIM(d.capabilities->>'serial'),'') IS NOT NULL AND
                NULLIF(TRIM(d.capabilities->>'manufacturer'),'') IS NOT NULL AND
                TRIM(other.capabilities->>'serial')=TRIM(d.capabilities->>'serial') AND
                TRIM(other.capabilities->>'manufacturer')=TRIM(d.capabilities->>'manufacturer') AND
                NULLIF(TRIM(other.capabilities->>'hardwareID'),'') IS NOT DISTINCT FROM
                  NULLIF(TRIM(d.capabilities->>'hardwareID'),''))
             )
           ) AS identity_conflict FROM onvif_devices d WHERE d.device_id=$1`;
export interface PtzCaps {
  panTilt: boolean;
  zoom: boolean;
  presets: boolean;
  presetWrite: boolean;
  position: boolean;
  moveStatus: boolean;
  relativePanTilt?: boolean;
  relativeZoom?: boolean;
  continuousPanTilt?: boolean;
  continuousZoom?: boolean;
  reason?: string;
}
export interface PtzAdapter {
  resource: string;
  videoSources?: string[];
  generation?: string;
  protocol: 'onvif' | 'gb28181';
  identity: string;
  caps: PtzCaps;
  verify?: () => Promise<void>;
  call: (action: string, body?: Record<string, unknown>) => Promise<any>;
}
const capabilities = z.object({
  // A fixed camera reports an empty resource with all motor capabilities false.
  resource: z.string().max(256).optional(),
  videoSources: z.array(z.string().min(1).max(256)).min(1).max(256).optional(),
  panTilt: z.boolean(),
  zoom: z.boolean(),
  presets: z.boolean(),
  presetWrite: z.boolean(),
  position: z.boolean(),
  moveStatus: z.boolean(),
  relativePanTilt: z.boolean(),
  relativeZoom: z.boolean(),
  continuousPanTilt: z.boolean(),
  continuousZoom: z.boolean(),
  reason: z.string().optional(),
});
function commandClock(body: Record<string, unknown>, offset: number) {
  const cmd = body.command as Record<string, unknown> | undefined;
  if (!cmd || cmd.stop) return body;
  return { ...body, command: { ...cmd, expiresAtMs: Date.now() + Number(cmd.ttlMs) + offset } };
}
function clockOffset(serverTime: unknown) {
  if (typeof serverTime !== 'number' || !Number.isSafeInteger(serverTime) || serverTime <= 0)
    throw new PtzError('ptz_invalid_response', 503);
  return serverTime - Date.now();
}
export async function preparePtzAdapter(
  root: Channel,
  store: PtzStore,
  onvif: OnvifManager | null,
  gb: GB28181Sync | null,
): Promise<PtzAdapter | null> {
  if (root.inputEnabled === false) throw new PtzError('ptz_input_disabled');
  if (root.onvif) {
    if (!onvif) throw new PtzError('ptz_service_unavailable', 503);
    const result = await onvif.preparePtz(root.onvif);
    const caps = capabilities.parse(result.capabilities);
    if (!caps.resource)
      return {
        resource: `onvif-fixed:${root.id}`,
        protocol: 'onvif',
        identity: JSON.stringify(root.onvif),
        caps,
        call: async () => {
          throw new PtzError('ptz_not_supported', 422);
        },
      };
    if (typeof result.context !== 'string' || !/^[a-f0-9]{48}$/.test(result.context))
      throw new PtzError('ptz_invalid_response', 503);
    const context = result.context,
      offset = clockOffset(result.serverTimeMs);
    const binding = root.onvif;
    return {
      videoSources: caps.videoSources,
      generation: result.generation,
      resource: `onvif:${caps.resource}`,
      identity: JSON.stringify(binding),
      protocol: 'onvif',
      caps,
      verify: async () => {
        const { rows } = await store.pool.query(
          ONVIF_IDENTITY_QUERY,
          [binding.deviceId],
        );
        if (Number(rows[0]?.version) !== binding.deviceVersion)
          throw new PtzError('ptz_source_changed');
        if (rows[0]?.identity_conflict) throw new PtzError('ptz_device_identity_conflict');
        if (!(await onvif.store.settings()).settings.enabled) throw new PtzError('ptz_disabled');
      },
      call: (action, body = {}) => onvif.ptz(action, { context, ...commandClock(body, offset) }),
    };
  }
  const { rows } = await store.pool.query(
    'SELECT binding_id,device_id,channel_id,stream_name,enabled FROM gb28181_bindings WHERE input_id=$1',
    [root.id],
  );
  if (!rows.length) return null;
  if (rows.length !== 1) throw new PtzError('ptz_source_ambiguous');
  const b = rows[0];
  if (
    !b.enabled ||
    root.upstreamProtocol !== 'rtmp' ||
    root.streamName !== b.stream_name ||
    (root.app || 'live') !== 'live'
  )
    throw new PtzError('ptz_source_changed');
  if (!gb) throw new PtzError('ptz_service_unavailable', 503);
  const r = await gb.ptz('prepare', { binding: b.binding_id });
  const parsed = z
    .object({
      resource: z.string(),
      revision: z.number().int().positive(),
      generation: z.number().int().positive(),
      ptzType: z.string(),
      position: z.literal(false),
      serverTimeMs: z.number().int().positive(),
    })
    .parse(r);
  const offset = clockOffset(parsed.serverTimeMs);
  const identity = JSON.stringify([b.binding_id, b.device_id, b.channel_id]);
  const key = ptzCameraKey(root, identity);
  const { settings } = await store.camera(key.key, key.identity);
  return {
    resource: `gb28181:${b.device_id}/${b.channel_id}`,
    identity,
    protocol: 'gb28181',
    caps: {
      panTilt: settings.panTilt === true,
      zoom: settings.zoom === true,
      presets: settings.presets === true,
      presetWrite: settings.presets === true,
      position: false,
      moveStatus: false,
      ...(!(settings.panTilt || settings.zoom || settings.presets)
        ? { reason: 'gb_capability_confirmation_required' }
        : {}),
    },
    verify: async () => {
      const { rows } = await store.pool.query(
        `SELECT b.device_id,b.channel_id,b.enabled,(SELECT COALESCE((document->>'enabled')::boolean,false) FROM gb28181_settings WHERE singleton) AS service_enabled FROM gb28181_bindings b WHERE b.binding_id=$1 AND b.input_id=$2`,
        [b.binding_id, root.id],
      );
      const row = rows[0];
      if (
        !row ||
        !row.enabled ||
        !row.service_enabled ||
        row.device_id !== b.device_id ||
        row.channel_id !== b.channel_id
      )
        throw new PtzError('ptz_source_changed');
    },
    call: (action, body = {}) =>
      gb.ptz(action, {
        binding: b.binding_id,
        revision: parsed.revision,
        generation: parsed.generation,
        ...commandClock(body, offset),
      }),
  };
}
