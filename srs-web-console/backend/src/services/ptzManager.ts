import { randomUUID } from 'node:crypto';
import { PtzError, PtzStore } from '../store/ptzStore.js';
import type { Channel } from '../types/channel.js';
import { resolvePtzSource, ptzCameraKey, type AiSourceLink } from './ptzSources.js';
import type { PtzAdapter } from './ptzAdapter.js';
export interface PtzVector {
  pan: number;
  tilt: number;
  zoom: number;
}
type Resolved = ReturnType<typeof resolvePtzSource>;
interface Lease {
  id: string;
  actor: string;
  channel: string;
  source: Resolved;
  adapter: PtzAdapter;
  sequence: number;
  stopped: boolean;
  until: number;
  timer?: ReturnType<typeof setTimeout>;
  uncertain: boolean;
  issued?: boolean;
  presetStarted?: number;
  presetIdleSamples?: number;
  presetCheckedAt?: number;
  guardRevision?: number;
  // Only undo our own successful preparation when no command was issued.
  unissuedBaseline?: { value: unknown };
  stopPending?: Promise<any>;
}
export interface PtzDependencies {
  channels: () => Promise<Channel[]>;
  ai: () => Promise<AiSourceLink[]>;
  prepare: (root: Channel) => Promise<PtzAdapter | null>;
  synchronize: () => Promise<{ state: string }>;
  resetProcessors: (ids: string[]) => Promise<void>;
  checkProcessors?: (ids: string[]) => Promise<void>;
}
export class PtzManager {
  private leases = new Map<string, Lease>();
  private preparations = new Map<string, Promise<PtzAdapter | null>>();
  private prepared = new Map<string, { adapter: PtzAdapter | null; at: number }>();
  private acquiring = new Set<string>();
  private cancelledAcquisitions = new Set<string>();
  private closing = false;
  private observerTimer?: ReturnType<typeof setTimeout>;
  private observing?: Promise<void>;
  private observed = new Map<
    string,
    { failures: number; retry: number; changed: number; recoveredRevision: number }
  >();
  private observerCursor = 0;
  constructor(
    public store: PtzStore,
    private deps: PtzDependencies,
  ) {}
  start() {
    if (this.observerTimer || this.closing) return;
    const tick = () => {
      if (this.closing) return;
      this.observing = this.observe()
        .catch(() => undefined)
        .finally(() => {
          this.observing = undefined;
          if (!this.closing) {
            this.observerTimer = setTimeout(tick, 5000);
            this.observerTimer.unref();
          }
        });
    };
    this.observerTimer = setTimeout(tick, 100);
    this.observerTimer.unref();
  }
  // Bounded background reconciliation. Camera status feedback is an optional
  // safety signal; absence of feedback is never treated as a restored view.
  async observe() {
    if (this.closing) return;
    const [channels, ai, guards] = await Promise.all([
      this.deps.channels(),
      this.deps.ai(),
      this.store.guards(),
    ]);
    const candidates = channels.filter((c) => c.onvif && c.inputEnabled !== false).map((c) => c.id);
    for (const g of guards)
      if (g.blocked) {
        const id = g.source_ids.find((id: string) => channels.some((c) => c.id === id));
        if (id && !candidates.includes(id)) candidates.unshift(id);
      }
    const ids = candidates.slice(this.observerCursor, this.observerCursor + 2);
    this.observerCursor =
      this.observerCursor + 2 >= candidates.length ? 0 : this.observerCursor + 2;
    for (const id of ids) {
      let resource = '';
      try {
        const base = resolvePtzSource(id, channels, ai);
        let a = await this.adapter(base);
        if (!a) continue;
        resource = a.resource;
        let state = this.observed.get(resource);
        if (!state) {
          if (this.observed.size >= 1024) continue;
          state = { failures: 0, retry: 0, changed: 0, recoveredRevision: 0 };
          this.observed.set(resource, state);
        }
        if (state.retry > Date.now() || this.acquiring.has(resource)) continue;
        const source = resolvePtzSource(id, channels, ai, a.videoSources);
        const guard = guards.find((g) => g.resource_key === resource),
          live = this.leases.get(resource);
        if (live && !live.stopped) continue;
        if (
          (guard?.stop_pending && state.recoveredRevision !== Number(guard.revision)) ||
          live?.uncertain
        ) {
          // Re-prepare after service restarts instead of retrying an expired handle.
          this.prepared.delete(base.fingerprint);
          a = await this.adapter(base);
          if (!a || a.resource !== resource) throw new PtzError('ptz_source_changed');
          const result = await a.call('command', {
            command: {
              session: randomUUID(),
              sequence: 1,
              stop: true,
              emergency: true,
              vector: { pan: 0, tilt: 0, zoom: 0 },
              ttlMs: 0,
            },
          });
          if (result.stopConfirmed !== true) throw new PtzError('ptz_stop_unconfirmed', 503);
          state.recoveredRevision = Number(guard?.revision ?? 0);
          if (guard) await this.store.stopped(resource, Number(guard.revision));
          if (live) live.uncertain = false;
        }
        if (a.caps.position && a.caps.moveStatus && !guard?.blocked) {
          const status = await a.call('status');
          if (!guard) {
            if (stationaryPtzPosition(status))
              await this.store.watch(resource, source.sourceIds, status);
          } else if (!guard.baseline) {
            if (stationaryPtzPosition(status))
              await this.store.observeBaseline(resource, Number(guard.revision), status);
          } else if (guard.baseline) {
            const moved = status?.panTilt === 'MOVING' || status?.zoom === 'MOVING';
            state.changed =
              moved || !samePtzPosition(guard.baseline, status) ? state.changed + 1 : 0;
            if (moved || state.changed >= 2) {
              await this.store.block(
                resource,
                source.sourceIds,
                'ptz-external-motion',
                guard.baseline,
                false,
              );
              await this.deps.synchronize();
              await this.deps.resetProcessors(source.processorIds);
              state.recoveredRevision = 0;
              state.changed = 0;
            }
          }
        }
        state.failures = 0;
        state.retry = Date.now() + 10000;
      } catch {
        const state = this.observed.get(resource);
        if (state) {
          state.failures++;
          state.retry = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(state.failures, 6));
        }
      }
    }
  }
  private async resolve(id: string, nodeSources?: string[]) {
    const [channels, ai] = await Promise.all([this.deps.channels(), this.deps.ai()]);
    return resolvePtzSource(id, channels, ai, nodeSources);
  }
  private async adapter(source: Resolved) {
    const key = source.fingerprint;
    const old = this.prepared.get(key);
    if (old && Date.now() - old.at < 30000) return old.adapter;
    let pending = this.preparations.get(key);
    if (pending) return pending;
    if (this.preparations.size >= 4) throw new PtzError('ptz_capacity_exceeded', 429);
    pending = this.deps
      .prepare(source.root)
      .then((adapter) => {
        if (this.prepared.size >= 128) this.prepared.delete(this.prepared.keys().next().value!);
        this.prepared.set(key, { adapter, at: Date.now() });
        return adapter;
      })
      .finally(() => this.preparations.delete(key));
    this.preparations.set(key, pending);
    return pending;
  }
  private async camera(source: Resolved, a: PtzAdapter) {
    const own = ptzCameraKey(source.root, a.identity);
    const camera = await this.store.camera(own.key, own.identity);
    if (source.root.onvif) {
      const settings = { ...camera.settings };
      // A restrictive setting on any source sharing this motor applies to all
      // profiles. A second stream must never bypass an operator's disable switch.
      for (const token of a.videoSources ?? []) {
        const key = ptzCameraKey({
          ...source.root,
          onvif: { ...source.root.onvif, videoSource: token },
        });
        if (key.key === own.key) continue;
        const other = await this.store.camera(key.key, key.identity);
        for (const flag of ['enabled', 'panTilt', 'zoom', 'presets'] as const)
          if (other.settings[flag] === false) settings[flag] = false;
      }
      return { ...camera, settings };
    }
    return camera;
  }
  private async target(id: string) {
    const base = await this.resolve(id),
      adapter = await this.adapter(base);
    const source = adapter?.videoSources ? await this.resolve(id, adapter.videoSources) : base;
    return { source, adapter };
  }
  private async exclusive<T>(
    id: string,
    actor: string,
    operation: (s: Resolved, a: PtzAdapter) => Promise<T>,
    allowDisabled = false,
  ) {
    const { source: s, adapter: a } = await this.target(id);
    if (!a) throw new PtzError('ptz_not_supported', 422);
    if (this.closing || this.acquiring.has(a.resource)) throw new PtzError('ptz_busy');
    this.acquiring.add(a.resource);
    try {
      const live = this.leases.get(a.resource);
      if (live && !live.stopped && live.actor !== actor) throw new PtzError('ptz_busy');
      if (live && !live.stopped) await this.stopLease(live);
      if (live?.uncertain) throw new PtzError('ptz_stop_unconfirmed', 503);
      await a.verify?.();
      const [global, camera] = await Promise.all([this.store.settings(), this.camera(s, a)]);
      if (
        !allowDisabled &&
        (!global.settings.enabled || !camera.settings.enabled || camera.settings.presets === false)
      )
        throw new PtzError('ptz_disabled');
      const current = await this.resolve(id, a.videoSources);
      if (current.fingerprint !== s.fingerprint) throw new PtzError('ptz_source_changed');
      return await operation(s, a);
    } finally {
      this.acquiring.delete(a.resource);
    }
  }
  async inspect(id: string) {
    const { source, adapter } = await this.target(id);
    if (!adapter)
      return {
        supported: false,
        source: { id: source.root.id, name: source.root.name },
        reason: 'ptz_not_supported',
      };
    const [global, camera, guard] = await Promise.all([
      this.store.settings(),
      this.camera(source, adapter),
      this.store.guard(adapter.resource),
    ]);
    const caps = { ...adapter.caps };
    if (camera.settings.panTilt === false) caps.panTilt = false;
    if (camera.settings.zoom === false) caps.zoom = false;
    if (camera.settings.presets === false) caps.presets = false;
    const lease = this.leases.get(adapter.resource);
    return {
      supported: caps.panTilt || caps.zoom || caps.presets,
      source: { id: source.root.id, name: source.root.name },
      protocol: adapter.protocol,
      capabilities: caps,
      enabled: global.settings.enabled && camera.settings.enabled,
      identity: source.fingerprint,
      camera,
      guard,
      busy: !!lease && !lease.stopped && lease.until > Date.now(),
      stopUnconfirmed: lease?.uncertain ?? false,
    };
  }
  async protection() {
    // Persisted status remains visible even while the AI/protocol service is offline.
    const [channels, guards, bindings] = await Promise.all([
      this.deps.channels(),
      this.store.guards(),
      this.store.pool.query('SELECT input_id FROM gb28181_bindings WHERE input_id IS NOT NULL'),
    ]);
    const gb = new Set(bindings.rows.map((r) => r.input_id));
    return {
      items: guards
        .filter((g) => g.blocked || g.stop_pending)
        .map((g) => {
          const affected = channels.filter((c) => g.source_ids.includes(c.id));
          const original = affected.find((c) => c.onvif || gb.has(c.id));
          return {
            source: original ? { id: original.id, name: original.name } : null,
            channels: affected.map((c) => ({ id: c.id, name: c.name })),
            blocked: !!g.blocked,
            stopPending: !!g.stop_pending,
            reason: g.actor === 'ptz-external-motion' ? 'external_motion' : 'camera_control',
            changedAt: new Date(g.changed_at).toISOString(),
          };
        }),
    };
  }
  async catalog() {
    const [channels, ai] = await Promise.all([this.deps.channels(), this.deps.ai()]);
    const { rows } = await this.store.pool.query(
      'SELECT input_id FROM gb28181_bindings WHERE input_id IS NOT NULL',
    );
    const gb = new Set(rows.map((r) => r.input_id));
    return {
      items: channels.map((c) => {
        try {
          const s = resolvePtzSource(c.id, channels, ai);
          return {
            channelId: c.id,
            sourceId: s.root.id,
            sourceName: s.root.name,
            candidate: (() => {
              const cached = this.prepared.get(s.fingerprint)?.adapter;
              if (
                cached?.protocol === 'onvif' &&
                !cached.caps.panTilt &&
                !cached.caps.zoom &&
                !cached.caps.presets
              )
                return false;
              return !!s.root.onvif || gb.has(s.root.id);
            })(),
          };
        } catch {
          return { channelId: c.id, candidate: false, reason: 'ptz_source_ambiguous' };
        }
      }),
    };
  }
  async acquire(id: string, actor: string, identity: string) {
    if (this.closing) throw new PtzError('ptz_service_stopping', 503);
    const { source, adapter } = await this.target(id);
    if (source.fingerprint !== identity) throw new PtzError('ptz_source_changed');
    if (!adapter) throw new PtzError('ptz_not_supported', 422);
    const [global, camera] = await Promise.all([
      this.store.settings(),
      this.camera(source, adapter),
    ]);
    if (!global.settings.enabled || !camera.settings.enabled) throw new PtzError('ptz_disabled');
    for (const [key, l] of this.leases)
      if (l.stopped && !l.uncertain && Date.now() - l.until > 600000) this.leases.delete(key);
    const previous = this.leases.get(adapter.resource);
    if (
      this.acquiring.has(adapter.resource) ||
      (previous && !previous.stopped && previous.until > Date.now())
    )
      throw new PtzError('ptz_busy');
    if (!this.leases.has(adapter.resource) && this.leases.size >= 128)
      throw new PtzError('ptz_capacity_exceeded', 429);
    if (
      [...this.leases.values()].filter((l) => !l.stopped).length + this.acquiring.size >=
      global.settings.capacity
    )
      throw new PtzError('ptz_capacity_exceeded', 429);
    this.acquiring.add(adapter.resource);
    try {
      // A fresh Stop reconciles a crashed console's unknown prior controller.
      const stopped = await adapter.call('command', {
        command: {
          session: randomUUID(),
          sequence: 1,
          stop: true,
          emergency: true,
          vector: { pan: 0, tilt: 0, zoom: 0 },
          ttlMs: 0,
        },
      });
      if (stopped.stopConfirmed !== true) throw new PtzError('ptz_stop_unconfirmed', 503);
      const check = await this.resolve(id, adapter.videoSources);
      if (check.fingerprint !== source.fingerprint) throw new PtzError('ptz_source_changed');
      // Capability-only preflight cannot reset media or pause rules.
      await this.deps.checkProcessors?.(source.processorIds);
      const existing = await this.store.guard(adapter.resource);
      let baseline: unknown = existing?.baseline ?? null;
      if (!existing?.blocked && !baseline && adapter.caps.position) {
        try {
          const reported = await adapter.call('status');
          if (stationaryPtzPosition(reported)) baseline = reported;
        } catch {}
      }
      const guardRevision = await this.store.block(
        adapter.resource,
        source.sourceIds,
        actor,
        baseline,
      );
      let application: { state: string };
      try {
        application = await this.deps.synchronize();
      } catch {
        throw new PtzError('ptz_arming_pause_pending', 503);
      }
      if (application.state !== 'applied') throw new PtzError('ptz_arming_pause_pending', 503);
      try {
        await this.deps.resetProcessors(source.processorIds);
      } catch {
        throw new PtzError('ptz_tracking_reset_pending', 503);
      }
      // Stop invalidates an acquisition already waiting on rule/AI readiness.
      // Never mint a usable control session after the operator stopped it.
      if (this.cancelledAcquisitions.has(adapter.resource) || this.closing)
        throw new PtzError('ptz_session_expired');
      const lease: Lease = {
        id: randomUUID(),
        actor,
        channel: id,
        source,
        adapter,
        sequence: 0,
        guardRevision,
        ...(!existing?.blocked ? { unissuedBaseline: { value: baseline } } : {}),
        stopped: false,
        until: Date.now() + 5000,
        uncertain: false,
      };
      this.leases.set(adapter.resource, lease);
      this.armTimer(lease, 5000);
      await this.store.record(actor, 'ptz-control-acquire');
      return {
        sessionId: lease.id,
        identity: source.fingerprint,
        leaseMs: global.settings.leaseMs,
      };
    } finally {
      this.acquiring.delete(adapter.resource);
      this.cancelledAcquisitions.delete(adapter.resource);
    }
  }
  private find(id: string, session: string, actor: string) {
    const lease = [...this.leases.values()].find(
      (l) => l.channel === id && l.id === session && l.actor === actor,
    );
    if (!lease) throw new PtzError('ptz_session_expired');
    return lease;
  }
  private armTimer(l: Lease, ms: number) {
    clearTimeout(l.timer);
    l.timer = setTimeout(() => {
      void this.stopLease(l).catch(() => undefined);
    }, ms);
    l.timer.unref();
  }
  private stopLease(l: Lease): Promise<any> {
    if (l.stopPending) return l.stopPending;
    if (l.stopped && !l.uncertain) return Promise.resolve({ stopConfirmed: true });
    l.stopped = true;
    l.sequence++;
    clearTimeout(l.timer);
    if (!l.issued) {
      l.stopPending = (async () => {
        if (l.guardRevision) {
          await this.store.stopped(l.adapter.resource, l.guardRevision);
          if (l.unissuedBaseline) {
            // CAS prevents undoing a newer external/manual protection event.
            // Failed preparations never create this successful lease, so their
            // fail-closed protection is deliberately not automatically restored.
            await this.store.restore(
              l.adapter.resource,
              l.guardRevision,
              l.actor,
              l.unissuedBaseline.value,
            );
            const result = await this.deps.synchronize();
            if (result.state !== 'applied') throw new PtzError('ptz_arming_restore_pending', 503);
          }
        }
        return { stopConfirmed: true };
      })().finally(() => {
        l.stopPending = undefined;
      });
      return l.stopPending;
    }
    l.uncertain = true;
    l.stopPending = l.adapter
      .call('command', {
        command: {
          session: l.id,
          sequence: l.sequence,
          stop: true,
          vector: { pan: 0, tilt: 0, zoom: 0 },
          ttlMs: 0,
        },
      })
      .then(async (result) => {
        l.uncertain = result.stopConfirmed !== true;
        if (l.uncertain) throw new PtzError('ptz_stop_unconfirmed', 503);
        if (l.guardRevision) await this.store.stopped(l.adapter.resource, l.guardRevision);
        return result;
      })
      .catch(() => {
        l.uncertain = true;
        throw new PtzError('ptz_stop_unconfirmed', 503);
      })
      .finally(() => {
        l.stopPending = undefined;
      });
    return l.stopPending;
  }
  async stop(id: string, session: string, actor: string) {
    const l = this.find(id, session, actor);
    return this.stopLease(l);
  }
  async command(
    id: string,
    session: string,
    actor: string,
    sequence: number,
    vector: PtzVector,
    preset?: string,
    keepAlive = false,
  ) {
    const l = this.find(id, session, actor);
    if (l.stopped || Date.now() > l.until) throw new PtzError('ptz_session_expired');
    if (sequence <= l.sequence) throw new PtzError('ptz_stale_command');
    l.sequence = sequence;
    const intent = sequence;
    const current = await this.resolve(id, l.adapter.videoSources);
    if (current.fingerprint !== l.source.fingerprint || current.root.inputEnabled === false) {
      await this.stopLease(l);
      throw new PtzError('ptz_source_changed');
    }
    try {
      await l.adapter.verify?.();
    } catch (e) {
      this.prepared.clear();
      await this.stopLease(l).catch(() => undefined);
      throw e;
    }
    const [global, camera] = await Promise.all([
      this.store.settings(),
      this.camera(current, l.adapter),
    ]);
    if (!global.settings.enabled || !camera.settings.enabled) {
      await this.stopLease(l);
      throw new PtzError('ptz_disabled');
    }
    if (!keepAlive && !preset && !vector.pan && !vector.tilt && !vector.zoom)
      throw new PtzError('ptz_invalid_vector', 422);
    const caps = l.adapter.caps;
    if (
      !keepAlive &&
      (((vector.pan || vector.tilt) && (!caps.panTilt || camera.settings.panTilt === false)) ||
        (vector.zoom && (!caps.zoom || camera.settings.zoom === false)) ||
        (preset && (!caps.presets || camera.settings.presets === false)))
    )
      throw new PtzError('ptz_operation_unsupported', 422);
    if (l.stopped || l.sequence !== intent || Date.now() > l.until)
      throw new PtzError('ptz_stale_command');
    const ttl = global.settings.leaseMs;
    l.until = Date.now() + ttl;
    this.armTimer(l, ttl);
    l.issued = true;
    try {
      const result = await l.adapter.call('command', {
        command: {
          session: l.id,
          sequence,
          vector,
          ttlMs: ttl,
          ...(preset ? { preset } : {}),
          ...(keepAlive ? { keepAlive: true } : {}),
        },
      });
      if (preset) {
        l.presetStarted = Date.now();
        l.presetIdleSamples = 0;
      }
      if (
        keepAlive &&
        l.presetStarted &&
        caps.moveStatus &&
        Date.now() - l.presetStarted >= 1000 &&
        Date.now() - (l.presetCheckedAt ?? 0) >= 500
      ) {
        l.presetCheckedAt = Date.now();
        // Static position alone does not prove arrival. Require explicit idle
        // feedback twice; missing/error/UNKNOWN feedback resets the evidence.
        let status: any;
        try {
          status = await l.adapter.call('status');
        } catch {
          status = null;
        }
        const idle =
          (!caps.panTilt || status?.panTilt === 'IDLE') &&
          (!caps.zoom || status?.zoom === 'IDLE') &&
          (caps.panTilt || caps.zoom);
        l.presetIdleSamples = idle ? (l.presetIdleSamples ?? 0) + 1 : 0;
        if (l.stopped || l.sequence !== intent) throw new PtzError('ptz_stale_command');
        if (l.presetIdleSamples >= 2) {
          const stopped = await this.stopLease(l);
          if (!stopped.stopConfirmed) throw new PtzError('ptz_stop_unconfirmed');
          return { ...result, motionFinished: true };
        }
      }
      return result;
    } catch (e) {
      this.prepared.clear();
      await this.stopLease(l).catch(() => undefined);
      throw e;
    }
  }
  async presets(id: string) {
    const { source: s, adapter: a } = await this.target(id);
    if (!a || !a.caps.presets) return { items: [], supported: false };
    const saved = await this.store.presets(a.resource);
    let device: any[] = [],
      reason: string | undefined;
    try {
      device = await a.call('presets');
    } catch {
      reason = 'ptz_preset_query_unavailable';
    }
    if (!Array.isArray(device) || device.length > 255)
      throw new PtzError('ptz_invalid_response', 503);
    const items = new Map(
      device
        .filter((p) => typeof p.id === 'string' && typeof p.name === 'string')
        .map((p) => [p.id, { ...p, deviceState: 'device_reported' }]),
    );
    for (const p of saved)
      items.set(p.id, {
        ...items.get(p.id),
        ...p,
        available: reason ? true : items.has(p.id),
        deviceState: reason
          ? 'unconfirmed'
          : items.has(p.id)
            ? 'device_reported'
            : 'missing_on_device',
      });
    return { items: [...items.values()], supported: true, reason };
  }
  async savePreset(
    id: string,
    actor: string,
    input: { id?: string; name: string; shortcut: number | null },
  ) {
    return this.exclusive(id, actor, async (s, a) => {
      if (!a.caps.presetWrite) throw new PtzError('ptz_presets_unsupported', 422);
      if (input.shortcut !== null) {
        const old = await this.store.presets(a.resource);
        if (old.some((p) => p.shortcut === input.shortcut && p.id !== input.id))
          throw new PtzError('ptz_shortcut_in_use');
      }
      let native = input.id ?? '';
      if (a.protocol === 'gb28181' && !native) {
        const p = await this.presets(id);
        if (p.reason) throw new PtzError('ptz_preset_query_required');
        const used = new Set(p.items.map((p) => p.id));
        native =
          Array.from({ length: 255 }, (_, i) => String(i + 1)).find((n) => !used.has(n)) ?? '';
        if (!native) throw new PtzError('ptz_preset_capacity');
      }
      const result = await a.call('preset-save', { presetId: native, name: input.name });
      const nativeId = result.id;
      if (typeof nativeId !== 'string' || !nativeId || nativeId.length > 256)
        throw new PtzError('ptz_invalid_response', 503);
      let position: unknown = null;
      if (a.caps.position) {
        try {
          position = await a.call('status');
        } catch {}
      }
      try {
        await this.store.savePreset(
          a.resource,
          nativeId,
          input.name,
          input.shortcut,
          position,
          actor,
        );
      } catch {
        throw new PtzError('ptz_preset_device_saved_metadata_failed', 503);
      }
      return {
        id: nativeId,
        deviceState: a.protocol === 'gb28181' ? 'delivery_accepted' : 'device_accepted',
      };
    });
  }
  async removePreset(id: string, actor: string, preset: string) {
    return this.exclusive(id, actor, async (_s, a) => {
      if (!a.caps.presetWrite) throw new PtzError('ptz_presets_unsupported', 422);
      await a.call('preset-remove', { presetId: preset });
      try {
        await this.store.removePreset(a.resource, preset, actor);
      } catch {
        throw new PtzError('ptz_preset_device_removed_metadata_failed', 503);
      }
      return { removed: true };
    });
  }
  async emergencyStop(id: string, actor: string) {
    const { source: s, adapter: a } = await this.target(id);
    if (!a) throw new PtzError('ptz_not_supported', 422);
    if (this.acquiring.has(a.resource)) this.cancelledAcquisitions.add(a.resource);
    const l = this.leases.get(a.resource);
    if (l) {
      l.stopped = true;
      clearTimeout(l.timer);
    }
    const revision = await this.store.block(a.resource, s.sourceIds, actor);
    await this.deps.synchronize();
    try {
      const result = await a.call('command', {
        command: {
          session: randomUUID(),
          sequence: 1,
          stop: true,
          emergency: true,
          vector: { pan: 0, tilt: 0, zoom: 0 },
          ttlMs: 0,
        },
      });
      if (result.stopConfirmed !== true) throw Error();
      await this.store.stopped(a.resource, revision);
      if (l) l.uncertain = false;
      return result;
    } catch {
      if (l) l.uncertain = true;
      throw new PtzError('ptz_stop_unconfirmed', 503);
    }
  }
  async restoreView(id: string, actor: string, revision: number, mode: 'position' | 'rearmed') {
    return this.exclusive(
      id,
      actor,
      async (s, a) => {
        const guard = await this.store.guard(a.resource);
        if (!guard?.blocked || Number(guard.revision) !== revision)
          throw new PtzError('version_conflict');
        const stopped = await a.call('command', {
          command: {
            session: randomUUID(),
            sequence: 1,
            stop: true,
            emergency: true,
            vector: { pan: 0, tilt: 0, zoom: 0 },
            ttlMs: 0,
          },
        });
        if (stopped.stopConfirmed !== true) throw new PtzError('ptz_stop_unconfirmed', 503);
        await this.store.stopped(a.resource, revision);
        let restoredBaseline: unknown = null;
        if (mode === 'position') {
          if (!a.caps.position || !guard.baseline) throw new PtzError('ptz_view_rearming_required');
          const current = await a.call('status');
          restoredBaseline = current;
          if (!samePtzPosition(guard.baseline, current))
            throw new PtzError('ptz_view_not_restored');
        } else {
          // Acknowledging a dialog is insufficient: all existing arming documents on
          // the affected sources must actually have been saved after this movement.
          const { rows } = await this.store.pool.query(
            `SELECT updated_at FROM alarm_arming_sources WHERE source_id=ANY($1::text[]) UNION ALL SELECT updated_at FROM alarm_monitors WHERE channel_id=ANY($1::text[])`,
            [guard.source_ids],
          );
          if (rows.some((r) => Date.parse(r.updated_at) < Date.parse(guard.changed_at)))
            throw new PtzError('ptz_view_rearming_required');
        }
        if (mode === 'rearmed' && a.caps.position) {
          try {
            const reported = await a.call('status');
            if (stationaryPtzPosition(reported)) restoredBaseline = reported;
          } catch {}
        }
        await this.deps.resetProcessors(s.processorIds);
        await this.store.restore(a.resource, revision, actor, restoredBaseline);
        const result = await this.deps.synchronize();
        if (result.state !== 'applied') throw new PtzError('ptz_arming_restore_pending', 503);
        return { restored: true };
      },
      true,
    );
  }
  async invalidateCamera(key: string) {
    const affected = [...this.leases.values()].filter((l) => {
      const root = l.source.root;
      if (ptzCameraKey(root, l.adapter.identity).key === key) return true;
      return (
        !!root.onvif &&
        (l.adapter.videoSources ?? []).some(
          (token) =>
            ptzCameraKey({ ...root, onvif: { ...root.onvif!, videoSource: token } }).key === key,
        )
      );
    });
    this.prepared.clear();
    const results = await Promise.allSettled(affected.map((l) => this.stopLease(l)));
    return { state: results.some((r) => r.status === 'rejected') ? 'stop_unconfirmed' : 'applied' };
  }
  async invalidate() {
    const results = await Promise.allSettled(
      [...this.leases.values()].map((l) => this.stopLease(l)),
    );
    this.prepared.clear();
    if (results.some((r) => r.status === 'rejected'))
      throw new PtzError('ptz_settings_saved_stop_unconfirmed', 503);
  }
  async close() {
    this.closing = true;
    clearTimeout(this.observerTimer);
    await this.observing;
    await Promise.allSettled([...this.leases.values()].map((l) => this.stopLease(l)));
    this.prepared.clear();
  }
}
export function stationaryPtzPosition(value: any) {
  const p = value?.position;
  if (!p) return false;
  const pan =
    Number.isFinite(p.Pan) &&
    Number.isFinite(p.Tilt) &&
    typeof p.PanTiltSpace === 'string' &&
    !!p.PanTiltSpace;
  const zoom = Number.isFinite(p.Zoom) && typeof p.ZoomSpace === 'string' && !!p.ZoomSpace;
  return (pan || zoom) && (!pan || value.panTilt === 'IDLE') && (!zoom || value.zoom === 'IDLE');
}
export function samePtzPosition(before: any, after: any) {
  if (!stationaryPtzPosition(after) || !before?.position) return false;
  const a = before.position,
    b = after.position;
  if (a.PanTiltSpace !== b.PanTiltSpace || a.ZoomSpace !== b.ZoomSpace) return false;
  const axes = ['Pan', 'Tilt', 'Zoom'];
  let count = 0;
  for (const key of axes) {
    if (a[key] == null && b[key] == null) continue;
    if (!Number.isFinite(a[key]) || !Number.isFinite(b[key]) || Math.abs(a[key] - b[key]) > 0.0001)
      return false;
    count++;
  }
  return count > 0;
}
