import { FrameFollower, followFreshMs, followHoldMs, followPickMs } from './ptzFollow.js';
import { createHash, randomUUID } from 'node:crypto';
import { PtzError, PtzStore, type CalibrationSnapshot } from '../store/ptzStore.js';
import type { Channel } from '../types/channel.js';
import { resolvePtzSource, ptzCameraKey, localRtmpStreamPath, type AiSourceLink } from './ptzSources.js';
import type { PtzAdapter } from './ptzAdapter.js';
import type {PresetHome,PresetSelection} from './presetHome.js';
export interface PtzVector {
  pan: number;
  tilt: number;
  zoom: number;
}
type Resolved = ReturnType<typeof resolvePtzSource>;
const onvifSpaces = 'http://www.onvif.org/ver10/tptz/';
const patrolSampleMaxAgeMs = 1000;

function patrolAxis(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new PtzError('ptz_position_unavailable', 422);
  return value;
}
interface CalibrationView { identity: string; width: number; height: number; estimator?: 'neuflow-v1' }
function calibrationDigest(parts: unknown[]) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
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
  changesCalibration?: boolean;
  presetStarted?: number;
  presetIdleSamples?: number;
  presetCheckedAt?: number;
  guardRevision?: number;
  presetProof?: {home:PresetHome;arrived:boolean;at:number};
  // Only undo our own successful preparation when no command was issued.
  unissuedBaseline?: { value: unknown };
  follow?: FrameFollower;
  wireSession?: string;
  stopPending?: Promise<any>;
}
export interface PtzDependencies {
  presetBindings?:boolean;
  channels: () => Promise<Channel[]>;
  ai: () => Promise<AiSourceLink[]>;
  prepare: (root: Channel) => Promise<PtzAdapter | null>;
  synchronize: () => Promise<{ state: string }>;
  latestFrame?: (id:string)=>Promise<unknown>;
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
  private readonly motorKeys = new Map<string, string>();
  private readonly emergency = new Map<string, Promise<{stopConfirmed: true}>>();
  private motor(resource: string) { return this.motorKeys.get(resource) ?? resource; }
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
    groups: unknown = JSON.parse(process.env.AINVR_PTZ_MOTOR_GROUPS || '[]'),
  ) {
    if (!Array.isArray(groups) || groups.length > 256) throw Error('Invalid PTZ motor groups');
    for (const group of groups) {
      if (!Array.isArray(group) || group.length < 2 || group.length > 16) throw Error('Invalid PTZ motor group');
      for (const key of group) {
        if (typeof key !== 'string' || !/^(onvif|gb28181):[^\s]{1,256}$/.test(key) || this.motorKeys.has(key))
          throw Error('Invalid or duplicate PTZ motor resource');
        this.motorKeys.set(key, group[0]);
      }
    }
  }
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
        const motor = this.motor(resource);
        if (state.retry > Date.now() || this.acquiring.has(motor) || this.emergency.has(motor)) continue;
        const source = resolvePtzSource(id, channels, ai, a.videoSources);
        const guard = guards.find((g) => g.resource_key === resource),
          live = this.leases.get(motor);
        if (live && (!live.stopped || live.stopPending)) continue;
        if (
          (guard?.stop_pending && state.recoveredRevision !== Number(guard.revision)) ||
          (live?.uncertain && live.adapter.resource === resource)
        ) {
          // Serialize recovery with control requests on every transport of this motor.
          this.acquiring.add(motor);
          try {
            const latest = await this.store.guard(resource);
            if (guard?.stop_pending && (!latest?.stop_pending || Number(latest.revision) !== Number(guard.revision))) continue;
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
            if (live?.adapter.resource === resource) live.uncertain = false;
          } finally { this.acquiring.delete(motor); this.cancelledAcquisitions.delete(motor); }
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
    return {...resolvePtzSource(id, channels, ai, nodeSources),
      displayedEnabled: channels.find(channel => channel.id === id)?.inputEnabled !== false};
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
  async sceneSource(id:string,processor?:string,observe=false) {
    const {source,adapter}=await this.target(id);
    if(!adapter || !(adapter.caps.panTilt||adapter.caps.zoom||adapter.caps.presets) || adapter.resource.startsWith('onvif-fixed:') || !source.displayedEnabled || source.root.id!==id || source.root.inputEnabled===false ||
       processor && !source.processorIds.includes(processor))return null;
    await adapter.verify?.();
    const motor=this.motor(adapter.resource);
    const idle=()=>{const l=this.leases.get(motor);return !this.closing && !this.acquiring.has(motor) &&
      !this.emergency.has(motor) && !(l && (!l.stopped || l.stopPending || l.uncertain));};
    let pose=null;
    if(observe && adapter.protocol==='onvif' && adapter.caps.moveStatus && adapter.caps.position){
      const status=await adapter.call('status');
      if(status?.panTilt==='MOVING'||status?.zoom==='MOVING')throw new PtzError('ptz_busy');
      if(stationaryPtzPosition(status) && status.panTilt==='IDLE' && status.zoom==='IDLE' &&
         Number.isFinite(status.position.Zoom)&&Number.isFinite(status.position.Pan)&&Number.isFinite(status.position.Tilt)&&
         typeof status.position.PanTiltSpace==='string'&&status.position.PanTiltSpace&&typeof status.position.ZoomSpace==='string'&&status.position.ZoomSpace)
        pose={position:status.position,panTilt:'IDLE',zoom:'IDLE',protocol:'onvif'};
    }
    return {identity:calibrationDigest([source.fingerprint,adapter.resource,adapter.identity]),resource:adapter.resource,
      app:source.root.app||'live',stream:source.root.streamName,idle:idle(),pose};
  }
  async presetBindingCapability(id:string){
    const {adapter:a}=await this.target(id);
    const available=!!this.deps.presetBindings&&!!a&&a.protocol==='onvif'&&a.caps.presets&&a.caps.position&&a.caps.moveStatus;
    return {presetBindingAvailable:available,presetBindingReason:available?'':'正式预置位布防需要已验证的 ONVIF 位置与停止反馈；当前来源暂不支持',experimentalProjectionEnabled:false};
  }
  private async presetHome(id:string,preset:string):Promise<PresetHome>{
    if(!(await this.presetBindingCapability(id)).presetBindingAvailable)throw new PtzError('ptz_preset_binding_unavailable',422);
    const {source,adapter:a}=await this.target(id);
    if(!a)throw new PtzError('ptz_not_supported',422);
    await a.verify?.();
    const list=await this.presets(id),entry=list.items.find(p=>p.id===preset);
    if(list.reason||!entry||entry.deviceState!=='device_reported'||!entry.fingerprint)throw new PtzError('ptz_preset_position_required',422);
    return {resource:a.resource,motor:this.motor(a.resource),identity:calibrationDigest([source.fingerprint,a.resource,a.identity]),
      preset_id:preset,preset_name:entry.name,preset_fingerprint:entry.fingerprint,definition_version:entry.definition_version,pose:entry.position};
  }
  async scenePreset(id:string,selection:PresetSelection,actor?:string):Promise<PresetHome>{
    const home=await this.presetHome(id,selection.preset_id);
    if(home.preset_fingerprint!==selection.preset_fingerprint)throw new PtzError('ptz_preset_changed',409);
    const ctx=await this.sceneSource(id,undefined,true),lease=this.leases.get(home.motor);
    if(!ctx?.idle||!ctx.pose||!samePtzPosition(home.pose,ctx.pose))throw new PtzError('ptz_preset_not_arrived',409);
    if(actor!==undefined){
      const proof=lease?.presetProof,guard=await this.store.guard(home.resource);
      if(!lease||lease.actor!==actor||lease.channel!==id||!lease.stopped||lease.stopPending||lease.uncertain||
        !proof?.arrived||Date.now()-proof.at>300000||proof.home.preset_fingerprint!==home.preset_fingerprint||
        proof.home.identity!==home.identity||Number(guard?.revision)!==lease.guardRevision||guard?.stop_pending)
        throw new PtzError('ptz_preset_goto_required',409);
    }
    return home;
  }
  private async presetMutation<T>(resource:string,preset:string,fn:()=>Promise<T>){
    if(!this.deps.presetBindings)return fn();
    const c=await this.store.pool.connect();let held=false;
    try{
      await c.query("SELECT pg_advisory_lock(hashtextextended('arming-preset-definition',0))");held=true;
      const bound=await c.query("SELECT 1 FROM arming_scene_zones WHERE binding_mode='preset' AND preset_home->>'motor'=$1 AND preset_home->>'preset_id'=$2 LIMIT 1",[this.motor(resource),preset]);
      if(bound.rowCount)throw new PtzError('ptz_preset_bound_unbind_first',409);
      if(preset)await c.query('INSERT INTO arming_preset_definitions(resource,preset_id,version) VALUES($1,$2,$3) ON CONFLICT(resource,preset_id) DO UPDATE SET version=excluded.version',[resource,preset,randomUUID()]);
      return await fn();
    }finally{try{if(held)await c.query("SELECT pg_advisory_unlock(hashtextextended('arming-preset-definition',0))");}finally{c.release();}}
  }
  private async exclusive<T>(
    id: string,
    actor: string,
    operation: (s: Resolved, a: PtzAdapter) => Promise<T>,
    allowDisabled = false,
    needsPresets = true,
  ) {
    const { source: s, adapter: a } = await this.target(id);
    if (!a) throw new PtzError('ptz_not_supported', 422);
    const motor = this.motor(a.resource);
    if (this.emergency.has(motor) || this.closing || this.acquiring.has(motor)) throw new PtzError('ptz_busy');
    this.acquiring.add(motor);
    try {
      const live = this.leases.get(motor);
      if (live && (!live.stopped || live.stopPending)) throw new PtzError('ptz_busy');
      if (live?.uncertain) throw new PtzError('ptz_stop_unconfirmed', 503);
      await a.verify?.();
      const [global, camera] = await Promise.all([this.store.settings(), this.camera(s, a)]);
      if (
        !allowDisabled &&
        (!global.settings.enabled || !camera.settings.enabled || (needsPresets && camera.settings.presets === false))
      )
        throw new PtzError('ptz_disabled');
      const current = await this.resolve(id, a.videoSources);
      if (current.fingerprint !== s.fingerprint ||
          (!allowDisabled && (!current.displayedEnabled || current.root.inputEnabled === false)))
        throw new PtzError('ptz_source_changed');
      if (this.cancelledAcquisitions.has(motor) || this.closing) throw new PtzError('ptz_session_expired');
      return await operation(s, a);
    } finally {
      this.acquiring.delete(motor);
      this.cancelledAcquisitions.delete(motor);
    }
  }
  private calibrationMotor(resource: string) {
    return calibrationDigest(this.presetGroup(resource).sort());
  }
  private checkCalibrationIdle(resource: string) {
    const lease = this.leases.get(this.motor(resource));
    if (lease?.changesCalibration && (!lease.stopped || lease.stopPending || lease.uncertain))
      throw new PtzError('ptz_calibration_busy');
  }
  async patrolPosition(id: string, identity: string) {
    const { source, adapter } = await this.target(id);
    const checkSource = (current: typeof source) => {
      if (current.fingerprint !== identity || !current.displayedEnabled || current.root.inputEnabled === false)
        throw new PtzError('ptz_source_changed');
      if (adapter?.protocol === 'onvif' && JSON.stringify(current.root.onvif) !== adapter.identity)
        throw new PtzError('ptz_source_changed');
    };
    checkSource(source);
    // GB PTZPosition currently exposes raw vendor units without verified axis ranges.
    if (adapter?.protocol !== 'onvif' || !adapter.caps.position)
      throw new PtzError('ptz_position_unavailable', 422);
    await adapter.verify?.();
    const [global, camera] = await Promise.all([this.store.settings(), this.camera(source, adapter)]);
    if (!global.settings.enabled || !camera.settings.enabled) throw new PtzError('ptz_disabled');

    // Each status call performs a fresh SOAP GetStatus. Bound its age through the final binding check.
    const started = performance.now();
    const status = await adapter.call('status');
    await adapter.verify?.();
    checkSource(await this.resolve(id, adapter.videoSources));
    if (performance.now() - started > patrolSampleMaxAgeMs) throw new PtzError('ptz_position_stale', 503);

    const p = status?.position;
    if (p?.ZoomSpace !== onvifSpaces + 'ZoomSpaces/PositionGenericSpace')
      throw new PtzError('ptz_position_unavailable', 422);
    const degrees = p.PanTiltSpace === onvifSpaces + 'PanTiltSpaces/SphericalPositionSpaceDegrees';
    if (!degrees && p.PanTiltSpace !== onvifSpaces + 'PanTiltSpaces/PositionGenericSpace')
      throw new PtzError('ptz_position_unavailable', 422);
    const scale = degrees ? 180 : 1;
    return {
      pan: patrolAxis(p.Pan, -scale, scale) / scale,
      tilt: patrolAxis(p.Tilt, -scale, scale) / scale,
      zoom: patrolAxis(p.Zoom, 0, 1),
      // Neither a velocity space nor these position URIs prove mechanical travel across the seam.
      wrap: false,
    };
  }
  async checkFlowContext(id: string, identity: string, epoch: number) {
    const {source, adapter} = await this.target(id);
    if (source.fingerprint !== identity || source.root.inputEnabled === false || !source.displayedEnabled)
      throw new PtzError('ptz_source_changed');
    if (!adapter?.caps.panTilt) throw new PtzError('ptz_not_supported', 422);
    await adapter.verify?.();
    const [global, camera] = await Promise.all([this.store.settings(), this.camera(source, adapter)]);
    if (!global.settings.enabled || !camera.settings.enabled || camera.settings.panTilt === false)
      throw new PtzError('ptz_disabled');
    if (await this.store.calibrationEpoch(this.calibrationMotor(adapter.resource)) !== epoch)
      throw new PtzError('ptz_calibration_stale');
  }
  private async calibrationContext(id: string, view: CalibrationView) {
    const {source, adapter} = await this.target(id);
    if (!adapter?.caps.panTilt) throw new PtzError('ptz_not_supported', 422);
    if (source.fingerprint !== view.identity || source.root.inputEnabled === false)
      throw new PtzError('ptz_source_changed');
    this.checkCalibrationIdle(adapter.resource);
    await adapter.verify?.();
    const [global, camera] = await Promise.all([this.store.settings(), this.camera(source, adapter)]);
    if (!global.settings.enabled || !camera.settings.enabled || camera.settings.panTilt === false)
      throw new PtzError('ptz_disabled');
    const motor = this.calibrationMotor(adapter.resource);
    // Fence a status response that straddles a zoom or native command on either alias.
    const epoch = await this.store.calibrationEpoch(motor);
    let zoom: [string | null, number] | null = null;
    if (adapter.caps.position) {
      const status = await adapter.call('status');
      if (!Number.isFinite(status?.position?.Zoom) || status?.zoom === 'MOVING' ||
          (adapter.caps.moveStatus && status?.zoom !== 'IDLE'))
        throw new PtzError('ptz_calibration_zoom_unavailable');
      zoom = [status.position.ZoomSpace ?? null, status.position.Zoom];
    }
    const [channels, links] = await Promise.all([this.deps.channels(), this.deps.ai()]);
    const current = resolvePtzSource(id, channels, links, adapter.videoSources);
    const displayed = channels.find(c => c.id === id);
    if (current.fingerprint !== view.identity || !displayed || displayed.inputEnabled === false)
      throw new PtzError('ptz_source_changed');
    this.checkCalibrationIdle(adapter.resource);
    const scope = calibrationDigest([1, motor, adapter.protocol, adapter.resource, adapter.identity,
      view.identity, id, displayed.inputGeneration, view.width, view.height, zoom,
      ...(view.estimator ? [view.estimator] : [])]);
    return {motor, scope, epoch, zoomEvidence: zoom ? 'measured' as const : 'unknown' as const};
  }
  async readCalibration(id: string, view: CalibrationView) {
    const {motor, scope, epoch, zoomEvidence} = await this.calibrationContext(id, view);
    const stored = await this.store.calibration(motor, scope);
    if (epoch !== stored.epoch) throw new PtzError('ptz_calibration_stale');
    return {scope, zoomEvidence, ...stored, ...(view.estimator && {estimator: view.estimator})};
  }
  async writeCalibration(id: string, view: CalibrationView & {
    scope: string; epoch: number; revision: number; snapshot: CalibrationSnapshot;
  }) {
    const {motor, scope, epoch} = await this.calibrationContext(id, view);
    if (epoch !== view.epoch || scope !== view.scope) throw new PtzError('ptz_calibration_stale');
    const saved = await this.store.saveCalibration(motor, scope, epoch, view.revision, view.snapshot);
    return {...saved, ...(view.estimator && {estimator: view.estimator})};
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
    if (camera.settings.panTilt === false) caps.pointCenter = false;
    const motor = this.motor(adapter.resource);
    const lease = this.leases.get(motor);
    return {
      supported: caps.panTilt || caps.zoom || caps.presets,
      source: { id: source.root.id, name: source.root.name },
      protocol: adapter.protocol,
      capabilities: caps,
      enabled: global.settings.enabled && camera.settings.enabled,
      identity: source.fingerprint,
      camera,
      guard,
      busy: this.emergency.has(motor) || this.acquiring.has(motor) || !!lease && (!lease.stopped || !!lease.stopPending),
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
  async acquire(id: string, actor: string, identity: string, processor?: string, calibrationEpoch?: number) {
    if (this.closing) throw new PtzError('ptz_service_stopping', 503);
    const { source, adapter } = await this.target(id);
    if (source.fingerprint !== identity || !source.displayedEnabled || source.root.inputEnabled === false)
      throw new PtzError('ptz_source_changed');
    if (!adapter) throw new PtzError('ptz_not_supported', 422);
    const [global, camera] = await Promise.all([
      this.store.settings(),
      this.camera(source, adapter),
    ]);
    if (!global.settings.enabled || !camera.settings.enabled) throw new PtzError('ptz_disabled');
    if (processor) {
      const [processors, channels] = await Promise.all([this.deps.ai(), this.deps.channels()]);
      const ai = processors.find(c => c.id === processor);
      const output = channels.find(c => c.id === id);
      if (!ai?.config.publish.enabled || !output || id === source.root.id ||
          localRtmpStreamPath(ai.config.publish.effective_target_url || ai.config.publish.target_url || '') !==
            '/' + (output.app || 'live') + '/' + output.streamName)
        throw new PtzError('ptz_follow_unavailable',422);
      const sourcePath = '/' + (source.root.app || 'live') + '/' + source.root.streamName;
      if (!this.deps.latestFrame || !adapter.caps.panTilt || camera.settings.panTilt === false ||
          !source.processorIds.includes(processor) || !ai || localRtmpStreamPath(ai.config.stream.url) !== sourcePath)
        throw new PtzError('ptz_follow_unavailable',422);
    }
    for (const [key, l] of this.leases)
      if (l.stopped && !l.uncertain && Date.now() - l.until > 600000) this.leases.delete(key);
    const motor = this.motor(adapter.resource);
    const previous = this.leases.get(motor);
    if (
      this.emergency.has(motor) || this.acquiring.has(motor) ||
      (previous && (!previous.stopped || previous.stopPending))
    )
      throw new PtzError('ptz_busy');
    if (previous?.uncertain && previous.adapter.resource !== adapter.resource) throw new PtzError('ptz_stop_unconfirmed', 503);
    if (!this.leases.has(motor) && this.leases.size >= 128)
      throw new PtzError('ptz_capacity_exceeded', 429);
    if (
      [...this.leases.values()].filter((l) => !l.stopped).length + this.acquiring.size >=
      global.settings.capacity
    )
      throw new PtzError('ptz_capacity_exceeded', 429);
    this.acquiring.add(motor);
    try {
      // Other windows using any alias must finish their field-of-view commands
      // before this check. Keep the motor reserved through lease publication.
      if (calibrationEpoch !== undefined &&
          await this.store.calibrationEpoch(this.calibrationMotor(adapter.resource)) !== calibrationEpoch)
        throw new PtzError('ptz_calibration_stale');
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
      if (check.fingerprint !== source.fingerprint || !check.displayedEnabled || check.root.inputEnabled === false)
        throw new PtzError('ptz_source_changed');
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
      await this.store.record(actor, 'ptz-control-acquire');
      if (this.cancelledAcquisitions.has(motor) || this.closing)
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
        until: Date.now() + (processor ? followPickMs : 5000),
        follow: processor ? new FrameFollower(processor, Date.now()) : undefined,
        uncertain: false,
      };
      this.leases.set(motor, lease);
      this.armTimer(lease, processor ? followPickMs : 5000);
      return {
        sessionId: lease.id,
        identity: source.fingerprint,
        leaseMs: global.settings.leaseMs,
      };
    } finally {
      this.acquiring.delete(motor);
      this.cancelledAcquisitions.delete(motor);
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
    const emergency = this.emergency.get(this.motor(l.adapter.resource));
    if (emergency) return emergency;
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
    const sequence = l.sequence;
    l.stopPending = l.adapter
      .call('command', {
        command: {
          session: l.wireSession ?? l.id,
          sequence,
          stop: true,
          vector: { pan: 0, tilt: 0, zoom: 0 },
          ttlMs: 0,
        },
      })
      .then(async (result) => {
        if (result?.stopConfirmed && l.sequence === sequence && l.guardRevision)
          await this.store.stopped(l.adapter.resource, l.guardRevision);
        return result;
      })
      .catch(() => undefined)
      .then(result => {
        // A priority Stop can overtake this session Stop on the wire.
        if (l.sequence !== sequence) {
          const newer = this.emergency.get(this.motor(l.adapter.resource));
          if (newer) return newer;
          if (!l.uncertain) return {stopConfirmed:true};
        } else {
          l.uncertain = result?.stopConfirmed !== true;
          if (!l.uncertain) return result;
        }
        throw new PtzError('ptz_stop_unconfirmed',503);
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
  private async commandSettings(l: Lease, sequence: number) {
    try {
      const current = await this.resolve(l.channel, l.adapter.videoSources);
      if (current.fingerprint !== l.source.fingerprint || current.root.inputEnabled === false || !current.displayedEnabled)
        throw new PtzError('ptz_source_changed');
      await l.adapter.verify?.();
      const [global, camera] = await Promise.all([this.store.settings(), this.camera(current, l.adapter)]);
      if (!global.settings.enabled || !camera.settings.enabled) throw new PtzError('ptz_disabled');
      return {global, camera};
    } catch (error) {
      if (l.stopped || l.sequence !== sequence) throw new PtzError('ptz_stale_command');
      this.prepared.clear();
      await this.stopLease(l);
      throw error;
    }
  }
  async command(
    id: string,
    session: string,
    actor: string,
    sequence: number,
    vector: PtzVector,
    preset?: string,
    keepAlive = false,
    center?: {x:number; y:number},
    follower?: FrameFollower,
  ) {
    const l = this.find(id, session, actor);
    if (l.follow !== follower) throw new PtzError('ptz_follow_session_required',409);
    if (l.stopped || Date.now() > l.until) throw new PtzError('ptz_session_expired');
    if (sequence <= l.sequence) throw new PtzError('ptz_stale_command');
    l.sequence = sequence;
    const intent = sequence;
    if(!keepAlive)l.presetProof=undefined;
    const home=preset&&this.deps.presetBindings?await this.presetHome(id,preset).catch(()=>null):null;
    const {global, camera} = await this.commandSettings(l, intent);
    if (center && (!l.adapter.caps.pointCenter || camera.settings.panTilt === false)) throw new PtzError('ptz_operation_unsupported',422);
    if (!keepAlive && !preset && !center && !vector.pan && !vector.tilt && !vector.zoom)
      throw new PtzError('ptz_invalid_vector', 422);
    const caps = l.adapter.caps;
    if (
      !keepAlive &&
      (((vector.pan || vector.tilt) && (!caps.panTilt || camera.settings.panTilt === false)) ||
        (vector.zoom && (!caps.zoom || camera.settings.zoom === false)) ||
        (preset && (!caps.presets || camera.settings.presets === false)))
    )
      throw new PtzError('ptz_operation_unsupported', 422);
    if (center || preset || vector.zoom) {
      if (l.stopped || l.sequence !== intent || Date.now() > l.until)
        throw new PtzError('ptz_stale_command');
      l.changesCalibration = true;
      await this.store.invalidateCalibration(this.calibrationMotor(l.adapter.resource));
    }
    if (l.stopped || l.sequence !== intent || Date.now() > l.until)
      throw new PtzError('ptz_stale_command');
    const ttl = follower ? Math.min(followFreshMs, Math.floor(follower.observationDeadline - Date.now()), global.settings.leaseMs) : global.settings.leaseMs;
    if (follower && (ttl < 100 || (follower.motionUntil && Date.now()>=follower.motionUntil))) {
      // The gateway requires at least 100 ms. A stale frame cannot renew motion.
      throw new PtzError('ptz_follow_motion_expired',409);
    }
    if (follower) {
      if (follower.holdUntil && Date.now() >= follower.holdUntil) throw new PtzError('ptz_follow_target_lost',409);
      if (follower.leadExpired(Date.now())) throw new PtzError('ptz_follow_motion_expired',409);
      if (follower.parked) l.wireSession=randomUUID();
      follower.parked=false;
      follower.dispatched(vector.pan,vector.tilt,Date.now());
      follower.resumed();
      this.watchFollowMotion(l,follower,Date.now()+ttl);
    } else {
      l.until = Date.now() + ttl;
      this.armTimer(l, ttl);
    }
    l.issued = true;
    try {
      const result = await l.adapter.call('command', {
        command: {
          session: l.wireSession ?? l.id,
          sequence,
          vector,
          ttlMs: ttl,
          ...(preset ? { preset } : {}),
          ...(center ? {center} : {}),
          ...(keepAlive ? { keepAlive: true } : {}),
        },
      });
      if (preset || center) {
        l.presetStarted = Date.now();
        l.presetIdleSamples = 0;
        if(home&&l.sequence===intent&&!l.stopped)l.presetProof={home,arrived:false,at:Date.now()};
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
        const targetAgrees=!l.presetProof||samePtzPosition(l.presetProof.home.pose,status);
        l.presetIdleSamples = idle&&targetAgrees ? (l.presetIdleSamples ?? 0) + 1 : 0;
        if (l.stopped || l.sequence !== intent) throw new PtzError('ptz_stale_command');
        if (l.presetIdleSamples >= 2) {
          const stopped = await this.stopLease(l);
          if (!stopped.stopConfirmed) throw new PtzError('ptz_stop_unconfirmed');
          if(l.presetProof){l.presetProof.arrived=true;l.presetProof.at=Date.now();}
          return { ...result, motionFinished: true };
        }
      }
      return result;
    } catch (e) {
      if (follower && !l.stopped && l.sequence!==intent && e instanceof Error &&
          ['ptz_stale_command','ptz_session_stopped','ptz_session_expired'].includes(e.message))
        throw new PtzError('ptz_stale_command',409);
      this.prepared.clear();
      await this.stopLease(l).catch(() => undefined);
      throw e;
    }
  }
  private async parkFollow(l:Lease, follow:FrameFollower) {
    if (follow.parked) return;
    follow.parking ??= (async () => {
      const result=await l.adapter.call('command',{command:{session:l.wireSession,sequence:++l.sequence,
        stop:true,vector:{pan:0,tilt:0,zoom:0},ttlMs:0}});
      if (!result.stopConfirmed) throw new PtzError('ptz_stop_unconfirmed',503);
      follow.parked=true;
      follow.dispatched(0,0,Date.now());
    })().finally(() => { follow.parking=undefined; });
    await follow.parking;
  }
  private watchFollowMotion(l:Lease, follow:FrameFollower, deadline:number) {
    follow.motionUntil=deadline;
    // Device TTL stays tied to evidence. Its watchdog brakes this selection
    // first. Only a confirmed stop can start a retention window.
    l.until=deadline+followPickMs;
    clearTimeout(l.timer);
    l.timer=setTimeout(() => {
      void this.holdFollow(l,follow,follow.target).catch(() => this.stopLease(l).catch(() => undefined));
    },Math.max(0,deadline-Date.now()));
    l.timer.unref();
  }
  private observeFollowIdle(l:Lease, follow:FrameFollower) {
    const sent=Date.now();
    if (!l.adapter.caps.moveStatus || follow.idleProbePending || sent<follow.idleProbeAfter) return;
    const sequence=l.sequence;
    follow.idleProbePending=true;
    follow.idleProbeAfter=sent+350;
    // A status read is optional and must not delay either sampling or Stop.
    void l.adapter.call('status').catch(() => null).then(status => {
      follow.idleProbePending=false;
      if (l.stopped || l.follow!==follow || !follow.parked || l.sequence!==sequence) return;
      const idle=status?.panTilt==='IDLE' && (!l.adapter.caps.zoom || status.zoom==='IDLE');
      follow.observeIdle(idle,sent,Date.now());
    });
  }
  private async holdFollow(l:Lease, follow:FrameFollower, track:string|undefined) {
    follow.hold(track);
    if (follow.holdUntil) return;
    if (!follow.holding) {
      ++l.sequence;
      follow.motionUntil=0;
      // Bound the stop RPC separately. No movement is permitted during it.
      l.until=Date.now()+12_000;
      this.armTimer(l,12_000);
      follow.holding=this.parkFollow(l,follow).then(() => {
        if (l.stopped || l.follow!==follow) throw new PtzError('ptz_session_expired');
        follow.holdUntil=Date.now()+followHoldMs;
        follow.needsHoldAck=true;
        l.until=follow.holdUntil+followPickMs;
        clearTimeout(l.timer);
        l.timer=setTimeout(() => this.resetFollowPick(l,follow),followHoldMs);
        l.timer.unref();
      }).finally(() => { follow.holding=undefined; });
    }
    await follow.holding;
  }
  private resetFollowPick(l:Lease, follow:FrameFollower) {
    if (l.stopped || l.follow!==follow || !follow.parked) return;
    ++l.sequence;
    const pick=new FrameFollower(follow.processor,Date.now());
    pick.needsDiscovery=true;
    pick.displayEpoch=follow.displayEpoch+1;
    l.follow=pick;
    l.until=pick.created+followPickMs;
    this.armTimer(l,followPickMs);
  }
  private async forgetFollow(l:Lease, follow:FrameFollower) {
    // A renderer generation change can arrive during the original stop RPC.
    // Finish that handshake before replacing the follower on this lease.
    if (follow.holding) await follow.holding;
    await this.parkFollow(l,follow);
    if (l.stopped) throw new PtzError('ptz_session_expired');
    this.resetFollowPick(l,follow);
  }
  async followStep(id:string, session:string, actor:string, track?:string, brakeOnly=false, displayEpoch=0) {
    const l=this.find(id,session,actor);
    const follow=l.follow;
    if (!follow || !this.deps.latestFrame || l.stopped || Date.now()>=l.until)
      throw new PtzError('ptz_session_expired');
    if (follow.holdUntil && Date.now()>=follow.holdUntil) this.resetFollowPick(l,follow);
    const reselect=() => ({choices:[],moving:false,reselect:true,displayEpoch:l.follow!.displayEpoch});
    const waiting=() => {
      follow.needsHoldAck=false;
      return {choices:[],moving:false,waiting:true,holdMs:Math.max(0,follow.holdUntil-Date.now())};
    };
    if (l.follow!==follow || (displayEpoch<follow.displayEpoch && !follow.target && !follow.heldId))
      return reselect();
    if (follow.needsDiscovery && (track || brakeOnly || displayEpoch!==follow.displayEpoch)) return reselect();
    // A brake may overtake a step fetching a frame, checking permissions, or
    // still on the network. Only its renderer epoch can subsequently resume.
    if (displayEpoch < follow.displayEpoch) return {choices:[],moving:false};
    if (brakeOnly) {
      try {
        follow.displayEpoch=displayEpoch;
        // Fence a recovery that has sampled a frame but is still in command guards.
        ++l.sequence;
        if (!track) {
          await this.forgetFollow(l,follow);
          return reselect();
        }
        await this.holdFollow(l,follow,track);
        return l.follow===follow ? waiting() : reselect();
      } catch (error) {
        if (!l.stopped && l.follow!==follow) return reselect();
        await this.stopLease(l);
        throw error;
      }
    }
    if (displayEpoch !== follow.displayEpoch || follow.processing || follow.parking || follow.holding) throw new PtzError('ptz_busy');
    follow.processing=true;
    const sequence=l.sequence;
    try {
      // A request delayed across the motion watchdog first learns that the
      // motor stopped. Resume requires another renderer check and request.
      if (follow.needsHoldAck) return waiting();
      if (follow.motionUntil && Date.now()>=follow.motionUntil) {
        await this.holdFollow(l,follow,follow.target);
        return waiting();
      }
      const data=await this.deps.latestFrame(follow.processor);
      if (l.follow!==follow) return reselect();
      if (l.stopped || Date.now()>=l.until) throw new PtzError('ptz_session_expired');
      if (sequence!==l.sequence) {
        await follow.holding;
        return l.follow!==follow ? reselect() : waiting();
      }
      const {choices,vector,repeat,missing}=follow.sample(data,track,Date.now());
      if (!track) {
        follow.needsDiscovery=false;
        return {choices};
      }
      if (missing) {
        await this.holdFollow(l,follow,track);
        return {...waiting(),choices};
      }
      // Polling can see the same AI frame twice. Preserve the previously issued
      // command only until its original deadline, without renewing its lease.
      if (repeat) return follow.holdUntil ? {...waiting(),choices} : {choices, moving:!follow.parked};
      if (vector && (vector.pan || vector.tilt || vector.zoom)) {
        await this.command(id,session,actor,l.sequence+1,vector,undefined,false,undefined,follow);
      } else {
        const epoch=follow.displayEpoch;
        const deadline=follow.holdUntil;
        await this.parkFollow(l,follow);
        if (l.stopped || Date.now()>=l.until) throw new PtzError('ptz_session_expired');
        if (l.follow!==follow) return reselect();
        if (epoch!==follow.displayEpoch || follow.holding || deadline!==follow.holdUntil) {
          await follow.holding;
          return waiting();
        }
        follow.resumed();
        this.watchFollowMotion(l,follow,follow.observationDeadline || Date.now()+followFreshMs);
        if (vector) this.observeFollowIdle(l,follow);
      }
      await follow.holding;
      if (l.stopped) throw new PtzError('ptz_session_expired');
      if (l.follow!==follow) return reselect();
      return follow.holdUntil ? {...waiting(),choices} : {choices,moving:!follow.parked};
    } catch (error) {
      if (l.stopped) throw error;
      if (l.follow!==follow) return reselect();
      if ((follow.holding || follow.holdUntil) && error instanceof Error && error.message==='ptz_stale_command') {
        await follow.holding;
        return waiting();
      }
      if (error instanceof Error && error.message==='ptz_follow_motion_expired') {
        await this.holdFollow(l,follow,track).catch(async e => { await this.stopLease(l); throw e; });
        return waiting();
      }
      if (error instanceof Error && ['ptz_follow_target_lost','ptz_follow_frame_stale'].includes(error.message)) {
        await this.forgetFollow(l,follow).catch(async e => { await this.stopLease(l); throw e; });
        return reselect();
      }
      await this.stopLease(l);
      throw error;
    } finally { follow.processing=false; }
  }
  async lens(id: string, actor: string, lens: string) {
    return this.exclusive(id, actor, async (_source, adapter) => {
      const caps = adapter.caps;
      const supported = lens === 'auto' ? caps.autoFocus :
        ['near', 'far'].includes(lens) ? caps.focus : caps.auxiliary?.includes(lens);
      if (!supported) throw new PtzError('ptz_operation_unsupported', 422);
      return adapter.call('lens', { lens });
    }, false, false);
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
    if (!Array.isArray(device) || device.length > (a.protocol === 'onvif' ? 1024 : 255)||
      device.some(p=>!p||typeof p.id!=='string'||!p.id||typeof p.name!=='string')||new Set(device.map(p=>p.id)).size!==device.length)
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
    if(this.deps.presetBindings&&a.protocol==='onvif'&&a.caps.position&&a.caps.moveStatus){
      const identity=calibrationDigest([s.fingerprint,a.resource,a.identity]);
      const versions=new Map<string,string>();
      if(!reason){
        const c=await this.store.pool.connect();
        try{
          await c.query('BEGIN');
          // Match scene-save lock order: configuration first, definition second.
          await c.query('SELECT revision FROM alarm_configuration_revision WHERE singleton FOR UPDATE');
          await c.query("SELECT pg_advisory_xact_lock(hashtextextended('arming-preset-definition',0))");
          // A complete successful device list is evidence of deletion. Rotate
          // once on that edge; failures never tombstone and reappearance cannot
          // restore a previous definition fingerprint.
          const missing=await c.query('UPDATE arming_preset_definitions SET version=gen_random_uuid(),present=false WHERE resource=$1 AND present AND NOT(preset_id=ANY($2::text[])) RETURNING preset_id',[a.resource,device.map(p=>p.id)]);
          if(missing.rowCount){
            const invalidated=await c.query("UPDATE arming_scene_zones SET state='pending',current_points=NULL,visual_checked_at=NULL,reason='布防预置位不可用：设备已确认预置位缺失',revision=nextval('arming_scene_revision'),changed_at=clock_timestamp(),checked_at=clock_timestamp() WHERE binding_mode='preset' AND resource=$1 AND preset_home->>'preset_id'=ANY($2::text[])",[a.resource,missing.rows.map(r=>r.preset_id)]);
            if(invalidated.rowCount)await c.query('UPDATE alarm_configuration_revision SET revision=revision+1 WHERE singleton');
          }
          const ids=device.map(p=>p.id);
          await c.query('INSERT INTO arming_preset_definitions(resource,preset_id,version,present) SELECT $1,id,gen_random_uuid(),true FROM unnest($2::text[]) AS ids(id) ON CONFLICT(resource,preset_id) DO UPDATE SET present=true WHERE NOT arming_preset_definitions.present',[a.resource,ids]);
          const definitions=await c.query('SELECT preset_id,version FROM arming_preset_definitions WHERE resource=$1 AND preset_id=ANY($2::text[])',[a.resource,ids]);
          for(const definition of definitions.rows)versions.set(definition.preset_id,definition.version);
          await c.query('COMMIT');
        }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
      }
      for(const [key,value] of items){
        const p=value as any;
        const pose=p.position;
        if(reason||p.deviceState!=='device_reported'||!stationaryPtzPosition(pose)||pose.panTilt!=='IDLE'||pose.zoom!=='IDLE'||
          !Number.isFinite(pose?.position?.Pan)||!Number.isFinite(pose?.position?.Tilt)||!Number.isFinite(pose?.position?.Zoom)||
          typeof pose.position.PanTiltSpace!=='string'||!pose.position.PanTiltSpace||typeof pose.position.ZoomSpace!=='string'||!pose.position.ZoomSpace){
          p.bindingReason='需要设备确认且具有已保存目标位置的预置位';continue;
        }
        p.definition_version=versions.get(key);
        p.fingerprint=calibrationDigest([identity,a.resource,key,p.definition_version,pose.position]);
      }
    }
    return { items: [...items.values()], supported: true, reason };
  }
  async savePreset(
    id: string,
    actor: string,
    input: { id?: string; name: string; shortcut: number | null },
  ) {
    return this.exclusive(id, actor, async (s, a) => {
      if (!a.caps.presetWrite) throw new PtzError('ptz_presets_unsupported', 422);
      const group = this.presetGroup(a.resource);
      if (input.shortcut !== null)
        await this.store.checkPresetShortcut(group, a.resource, input.id ?? '', input.shortcut);
      let native = input.id ?? '';
      if (a.protocol === 'gb28181' && !native) {
        const p = await this.presets(id);
        if (p.reason) throw new PtzError('ptz_preset_query_required');
        const used = new Set(p.items.map((p) => p.id));
        native =
          Array.from({ length: 255 }, (_, i) => String(i + 1)).find((n) => !used.has(n)) ?? '';
        if (!native) throw new PtzError('ptz_preset_capacity');
      }
      return this.presetMutation(a.resource,native,async()=>{
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
          group,
        );
      } catch {
        throw new PtzError('ptz_preset_device_saved_metadata_failed', 503);
      }
      return {
        id: nativeId,
        deviceState: a.protocol === 'gb28181' ? 'delivery_accepted' : 'device_accepted',
      };
      });
    });
  }
  async removePreset(id: string, actor: string, preset: string) {
    return this.exclusive(id, actor, async (_s, a) => {
      if (!a.caps.presetWrite) throw new PtzError('ptz_presets_unsupported', 422);
      return this.presetMutation(a.resource,preset,async()=>{
      await a.call('preset-remove', { presetId: preset });
      try {
        await this.store.removePreset(a.resource, preset, actor);
      } catch {
        throw new PtzError('ptz_preset_device_removed_metadata_failed', 503);
      }
      return { removed: true };
      });
    });
  }
  private presetGroup(resource: string) {
    const motor = this.motor(resource);
    if (!this.motorKeys.has(resource)) return [resource];
    return [...this.motorKeys].filter(([, key]) => key === motor).map(([alias]) => alias);
  }
  async updatePresetMetadata(id: string, actor: string, preset: string, input: {name:string; shortcut:number|null}) {
    return this.exclusive(id, actor, async (source, adapter) => {
      if (!adapter.caps.presets || !adapter.caps.presetWrite) throw new PtzError('ptz_presets_unsupported', 422);
      if (source.root.inputEnabled === false) throw new PtzError('ptz_input_disabled');
      // A stale local shortcut is not evidence that this native ID still exists.
      const listed: unknown = await adapter.call('presets').catch(() => {
        throw new PtzError('ptz_preset_query_required');
      });
      if (!Array.isArray(listed) || listed.length > (adapter.protocol === 'onvif' ? 1024 : 255) ||
          listed.some(p => !p || typeof p.id !== 'string' || typeof p.name !== 'string'))
        throw new PtzError('ptz_invalid_response', 503);
      const matches = listed.filter(p => p.id === preset);
      if (!matches.length) throw new PtzError('ptz_preset_not_found', 404);
      if (matches.length !== 1) throw new PtzError('ptz_invalid_response', 503);
      await adapter.verify?.();
      const current = await this.resolve(id, adapter.videoSources);
      if (source.fingerprint !== current.fingerprint || current.root.inputEnabled === false)
        throw new PtzError('ptz_source_changed');
      await this.store.updatePresetMetadata(adapter.resource, preset, input.name, input.shortcut, actor,
        this.presetGroup(adapter.resource));
      return {id:preset, name:input.name, shortcut:input.shortcut};
    });
  }
  async emergencyStop(id: string, actor: string) {
    // An already admitted session carries its verified physical destination.
    // A failed analytics/source lookup must not prevent braking that motor.
    const active = [...this.leases.values()].find(l => l.channel === id && (!l.stopped || l.stopPending || l.uncertain));
    const { source: s, adapter: a } = active ?? await this.target(id);
    if (!a) throw new PtzError('ptz_not_supported', 422);
    const motor = this.motor(a.resource);
    const pending = this.emergency.get(motor);
    if (pending) return pending;
    if (this.acquiring.has(motor)) this.cancelledAcquisitions.add(motor);
    const previous = this.leases.get(motor);
    const l = previous && (!previous.stopped || previous.stopPending || previous.uncertain) ? previous : undefined;
    if (l) {
      l.stopped = true;
      l.uncertain = true;
      ++l.sequence;
      clearTimeout(l.timer);
    }
    const adapter = l?.adapter ?? a;
    const work = Promise.resolve().then(async () => {
      const [wire, guard] = await Promise.allSettled([
        adapter.call('command', {command: {session: randomUUID(), sequence: 1, stop: true,
          emergency: true, vector: {pan: 0, tilt: 0, zoom: 0}, ttlMs: 0}}),
        this.store.block(adapter.resource, l?.source.sourceIds ?? s.sourceIds, actor).then(async revision => {
          if ((await this.deps.synchronize()).state !== 'applied') throw new PtzError('ptz_arming_pause_pending', 503);
          return revision;
        }),
      ]);
      if (wire.status === 'rejected' || wire.value?.stopConfirmed !== true) {
        if (l) l.uncertain = true;
        throw new PtzError('ptz_stop_unconfirmed', 503);
      }
      if (l) l.uncertain = false;
      if (guard.status === 'rejected') throw new PtzError('ptz_arming_pause_pending', 503);
      await this.store.stopped(adapter.resource, guard.value);
      return wire.value as {stopConfirmed: true};
    }).finally(() => this.emergency.delete(motor));
    this.emergency.set(motor, work);
    return work;
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
