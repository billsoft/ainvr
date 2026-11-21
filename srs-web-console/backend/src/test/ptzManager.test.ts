import { it, expect, vi } from 'vitest';
import { PtzManager, samePtzPosition } from '../services/ptzManager.js';
import * as viewConfirmation from '../store/armingViewConfirmation.js';
import type { PtzStore } from '../store/ptzStore.js';
import type { PtzAdapter } from '../services/ptzAdapter.js';
import type { Channel } from '../types/channel.js';
function fixture() {
  const root: Channel = {
    id: 'root',
    name: 'Gate',
    streamName: 'gate',
    upstreamProtocol: 'rtsp',
    downstreamProtocols: ['flv'],
    inputGeneration: 'g1',
    onvif: {
      deviceId: 'nvr',
      deviceVersion: 1,
      service: 'media1',
      profileToken: 'main',
      videoSource: 'sensor-a',
    },
    createdAt: 1,
    updatedAt: 1,
  };
  const log: string[] = [];
  const store = {
    invalidateCalibration: vi.fn(async () => undefined),
    calibrationEpoch: vi.fn(async () => 0),
    calibration: vi.fn(async () => ({epoch: 0, revision: 0, snapshot: null})),
    saveCalibration: vi.fn(async () => ({revision: 1})),
    settings: vi.fn(async () => ({ settings: { enabled: true, capacity: 4, leaseMs: 1200 } })),
    camera: vi.fn(async () => ({
      revision: 0,
      settings: { enabled: true, panTilt: null, zoom: null, presets: null },
    })),
    guard: vi.fn(async () => null),
    block: vi.fn(async () => {
      log.push('persist-block');
    }),
    record: vi.fn(async () => undefined),
    guards: vi.fn(async () => []),
    watch: vi.fn(async () => undefined),
    stopped: vi.fn(async () => undefined),
    presets: vi.fn(async () => []),
    checkPresetShortcut: vi.fn(async () => undefined),
    updatePresetMetadata: vi.fn(async () => undefined),
    savePreset: vi.fn(async () => undefined),
    removePreset: vi.fn(async () => undefined),
    restore: vi.fn(async () => undefined),
    observeBaseline: vi.fn(async () => undefined),
    pool: { query: vi.fn(async () => ({ rows: [] })) },
  } as unknown as PtzStore;
  const adapter: PtzAdapter = {
    resource: 'motor-1',
    protocol: 'onvif',
    identity: 'binding-1',
    caps: {
      panTilt: true,
      zoom: true,
      presets: true,
      presetWrite: true,
      position: false,
      moveStatus: false,
    },
    call: vi.fn(async (_action, body) => {
      const cmd = body?.command as any;
      log.push(cmd?.stop ? 'stop' : 'move');
      return { stopConfirmed: true };
    }),
  };
  const deps = {
    channels: vi.fn(async () => [root]),
    ai: vi.fn(async () => []),
    prepare: vi.fn(async () => adapter),
    synchronize: vi.fn(async () => {
      log.push('confirmed-pause');
      return { state: 'applied' };
    }),
    resetProcessors: vi.fn(async () => {
      log.push('tracking-reset');
    }),
  };
  return { manager: new PtzManager(store, deps), store, adapter, deps, root, log };
}
function patrolFixture() {
  const f = fixture();
  const base = 'http://www.onvif.org/ver10/tptz/';
  const position = {
    Pan: -1, Tilt: 1, Zoom: 0,
    PanTiltSpace: base + 'PanTiltSpaces/PositionGenericSpace',
    ZoomSpace: base + 'ZoomSpaces/PositionGenericSpace',
  };
  f.adapter.identity = JSON.stringify(f.root.onvif);
  f.adapter.verify = vi.fn(async () => undefined);
  f.adapter.caps.position = true;
  f.adapter.caps.continuousPanTilt = true;
  const call = vi.mocked(f.adapter.call);
  call.mockImplementation(async () => ({position, panTilt: 'MOVING'}));
  return {...f, base, position, call};
}
it('rearmed restoration resolves main/sub identity and processor ownership separately on their shared motor',async()=>{
 const f=fixture(),sub={...f.root,id:'sub',streamName:'sub',onvif:{...f.root.onvif!,profileToken:'sub'}};
 f.deps.channels.mockResolvedValue([f.root,sub]);
 f.deps.ai.mockResolvedValue([
  {id:'main-ai',config:{stream:{url:'rtmp://127.0.0.1/live/gate'},publish:{enabled:false}}},
  {id:'sub-ai',config:{stream:{url:'rtmp://127.0.0.1/live/sub'},publish:{enabled:false}}},
 ] as never);
 vi.mocked(f.store.guard).mockResolvedValue({revision:1,blocked:true} as any);
 const check=vi.spyOn(viewConfirmation,'assertCurrentViewConfirmations').mockResolvedValue();
 vi.mocked(f.store.restore).mockImplementation(async(_r,_v,_a,_b,validate)=>{await validate?.({} as any);});
 try{
  const main=await f.manager.sceneSource('root'),other=await f.manager.sceneSource('sub');
  expect(main!.identity).not.toBe(other!.identity);
  for(const entry of ['root','sub']){
   await f.manager.restoreView(entry,'operator',1,'rearmed');
   const evidence=check.mock.calls.at(-1)![4];
   expect(evidence).toEqual(expect.arrayContaining([
    expect.objectContaining({source:'root',processors:['main-ai'],identity:main!.identity}),
    expect.objectContaining({source:'sub',processors:['sub-ai'],identity:other!.identity}),
   ]));
  }
 }finally{check.mockRestore();await f.manager.close();}
});
it('preset goto rejects an overwritten expected fingerprint before motion and preserves ordinary goto compatibility',async()=>{
  const f=fixture();(f.deps as any).presetBindings=true;
  const home=vi.spyOn(f.manager as any,'presetHome').mockResolvedValue({preset_fingerprint:'b'.repeat(64)});
  try{
    const info=await f.manager.inspect('root'),lease=await f.manager.acquire('root','operator',info.identity!);
    vi.mocked(f.adapter.call).mockClear();
    await expect(f.manager.command('root',lease.sessionId,'operator',1,{pan:0,tilt:0,zoom:0},'1',false,undefined,undefined,'a'.repeat(64)))
      .rejects.toMatchObject({code:'ptz_preset_changed',statusCode:409});
    expect(f.adapter.call).not.toHaveBeenCalled();expect(home).toHaveBeenCalledTimes(1);
    await f.manager.command('root',lease.sessionId,'operator',2,{pan:0,tilt:0,zoom:0},'1',false,undefined,undefined,'b'.repeat(64));
    expect(f.adapter.call).toHaveBeenCalledTimes(1);
    await f.manager.command('root',lease.sessionId,'operator',3,{pan:0,tilt:0,zoom:0},'1');
    expect(f.adapter.call).toHaveBeenCalledTimes(2);
  }finally{await f.manager.close();}
});
it('reads each native status afresh, normalizes angular units, and never claims mechanical wrap', async () => {
  const f = patrolFixture();
  try {
    const identity = (await f.manager.inspect('root')).identity!;
    const read = () => f.manager.patrolPosition('root', identity);
    expect(await read()).toEqual({pan: -1, tilt: 1, zoom: 0, wrap: false});
    Object.assign(f.position, {PanTiltSpace: f.base + 'PanTiltSpaces/SphericalPositionSpaceDegrees',
      Pan: 90, Tilt: -135, Zoom: 1});
    expect(await read()).toEqual({pan: 0.5, tilt: -0.75, zoom: 1, wrap: false});
    expect(f.call.mock.calls).toEqual([['status'], ['status']]);
    expect(f.deps.resetProcessors).not.toHaveBeenCalled();
    expect(f.store.block).not.toHaveBeenCalled();
  } finally { await f.manager.close(); }
});
it('rejects incomplete, nonfinite, out-of-range and unknown-space positions without guessing units', async () => {
  const f = patrolFixture();
  try {
    const identity = (await f.manager.inspect('root')).identity!;
    for (const patch of [{Pan: NaN}, {Tilt: Infinity}, {Zoom: null}, {Pan: '0'}, {Pan: 1.01},
      {Tilt: -1.01}, {Zoom: -0.01}, {Zoom: 1.01}, {ZoomSpace: ''}, {PanTiltSpace: undefined},
      {PanTiltSpace: f.base + 'PanTiltSpaces/VelocityGenericSpace'},
      {PanTiltSpace: f.base + 'PanTiltSpaces/SphericalPositionSpaceDegrees', Pan: 181}]) {
      f.call.mockResolvedValueOnce({position: {...f.position, ...patch}});
      await expect(f.manager.patrolPosition('root', identity)).rejects.toThrow('ptz_position_unavailable');
    }
    for (const status of [{}, {position: null}]) {
      f.call.mockResolvedValueOnce(status);
      await expect(f.manager.patrolPosition('root', identity)).rejects.toThrow('ptz_position_unavailable');
    }
  } finally { await f.manager.close(); }
});
it('fences prior and in-flight binding changes and rejects delayed status', async () => {
  const f = patrolFixture();
  try {
    const identity = (await f.manager.inspect('root')).identity!;
    await expect(f.manager.patrolPosition('root', 'old')).rejects.toThrow('ptz_source_changed');
    f.adapter.identity = 'different prepared profile';
    await expect(f.manager.patrolPosition('root', identity)).rejects.toThrow('ptz_source_changed');
    expect(f.call).not.toHaveBeenCalled();
    f.adapter.identity = JSON.stringify(f.root.onvif);
    const clock = vi.spyOn(performance, 'now').mockReturnValue(5);
    try {
      f.call.mockImplementationOnce(async () => {
        clock.mockReturnValue(1006);
        return {position: f.position};
      });
      await expect(f.manager.patrolPosition('root', identity)).rejects.toThrow('ptz_position_stale');
    } finally { clock.mockRestore(); }
    f.call.mockImplementationOnce(async () => {
      f.root.inputGeneration = 'rebound';
      return {position: f.position};
    });
    await expect(f.manager.patrolPosition('root', identity)).rejects.toThrow('ptz_source_changed');
  } finally { await f.manager.close(); }
});
it('rejects disabled reads, missing native status and GB raw units before querying the device', async () => {
  const f = patrolFixture();
  try {
    const identity = (await f.manager.inspect('root')).identity!;
    const read = () => f.manager.patrolPosition('root', identity);
    vi.mocked(f.store.settings).mockResolvedValueOnce({settings: {enabled: false}} as any);
    await expect(read()).rejects.toThrow('ptz_disabled');
    f.adapter.caps.position = false;
    await expect(read()).rejects.toThrow('ptz_position_unavailable');
    f.adapter.caps.position = true;
    f.adapter.protocol = 'gb28181';
    await expect(read()).rejects.toThrow('ptz_position_unavailable');
    expect(f.call).not.toHaveBeenCalled();
  } finally { await f.manager.close(); }
});
it('isolates NeuFlow and legacy records on the same motor epoch', async () => {
  const f = fixture();
  try {
    const identity = (await f.manager.inspect('root')).identity!;
    const legacy = {identity, width:1920, height:1080};
    const flow = {...legacy, estimator:'neuflow-v1' as const};
    const original = await f.manager.readCalibration('root', legacy);
    const knownSnapshot = {version:1 as const, records:[]};
    vi.mocked(f.store.calibration).mockImplementation(async (_motor, scope) => scope === original.scope
      ? {epoch:0, revision:2, snapshot:knownSnapshot} : {epoch:0, revision:0, snapshot:null});
    const separate = await f.manager.readCalibration('root', flow);
    expect(separate).toMatchObject({epoch:original.epoch, revision:0, snapshot:null, estimator:'neuflow-v1'});
    expect(separate.scope).not.toBe(original.scope);
    const write = {...flow, epoch:0, revision:0, snapshot:knownSnapshot};
    await expect(f.manager.writeCalibration('root', {...write, scope:original.scope})).rejects.toThrow('ptz_calibration_stale');
    await expect(f.manager.writeCalibration('root', {...write, scope:separate.scope})).resolves.toEqual({revision:1, estimator:'neuflow-v1'});
    const again = await f.manager.readCalibration('root', legacy);
    expect(again).toMatchObject({scope:original.scope, revision:2, snapshot:knownSnapshot});
    expect(again).not.toHaveProperty('estimator');
    expect(new Set(vi.mocked(f.store.calibrationEpoch).mock.calls.map(([motor]) => motor)).size).toBe(1);
  } finally { await f.manager.close(); }
});
it('checks the displayed source, binding and epoch during motion and after release without motor commands', async () => {
  const f = fixture();
  try {
    const identity = (await f.manager.inspect('root')).identity!;
    const {sessionId} = await f.manager.acquire('root','operator',identity);
    await f.manager.command('root',sessionId,'operator',1,{pan:0.2,tilt:0,zoom:0});
    const calls = vi.mocked(f.adapter.call).mock.calls.length;
    await f.manager.checkFlowContext('root',identity,0);
    expect(f.adapter.call).toHaveBeenCalledTimes(calls);
    await f.manager.stop('root',sessionId,'operator');
    vi.mocked(f.adapter.call).mockClear();
    await f.manager.checkFlowContext('root',identity,0);
    await expect(f.manager.checkFlowContext('root',identity,1)).rejects.toThrow('ptz_calibration_stale');
    await expect(f.manager.checkFlowContext('root','old',0)).rejects.toThrow('ptz_source_changed');
    f.adapter.verify = vi.fn(async () => { throw new Error('binding changed'); });
    await expect(f.manager.checkFlowContext('root',identity,0)).rejects.toThrow('binding changed');
    expect(f.adapter.call).not.toHaveBeenCalled();
  } finally { await f.manager.close(); }
});
it('isolates scopes by actual zoom, space and geometry and checks identity before accessing status', async () => {
  const f = fixture();
  const identity = (await f.manager.inspect('root')).identity!;
  const view = {identity,width:1920,height:1080};
  try {
    const unknown = await f.manager.readCalibration('root',view);
    expect(unknown.zoomEvidence).toBe('unknown');
    expect(f.adapter.call).not.toHaveBeenCalled();
    f.adapter.caps.position = true;
    f.adapter.caps.moveStatus = true;
    const status = {position:{Zoom:0 as number|null, ZoomSpace:'generic'}, zoom:'IDLE'};
    vi.mocked(f.adapter.call).mockImplementation(async () => status);
    const measured = await f.manager.readCalibration('root',view);
    expect(measured.zoomEvidence).toBe('measured');
    expect(measured.scope).not.toBe(unknown.scope);
    expect((await f.manager.readCalibration('root',{...view,width:1280})).scope).not.toBe(measured.scope);
    status.position.ZoomSpace = 'other';
    expect((await f.manager.readCalibration('root',view)).scope).not.toBe(measured.scope);
    status.position.ZoomSpace = 'generic';
    status.position.Zoom = 0.1;
    const write = {...view,...measured,snapshot:{version:1 as const,records:[]}};
    await expect(f.manager.writeCalibration('root',write)).rejects.toThrow('ptz_calibration_stale');
    expect(f.store.saveCalibration).not.toHaveBeenCalled();
    status.position.Zoom = null;
    await expect(f.manager.readCalibration('root',view)).rejects.toThrow('ptz_calibration_zoom_unavailable');
    status.position.Zoom = 0;
    status.zoom = 'MOVING';
    await expect(f.manager.readCalibration('root',view)).rejects.toThrow('ptz_calibration_zoom_unavailable');
    status.zoom = 'IDLE';
    vi.mocked(f.store.calibrationEpoch).mockResolvedValueOnce(1);
    await expect(f.manager.readCalibration('root',view)).rejects.toThrow('ptz_calibration_stale');
    await expect(f.manager.writeCalibration('root',write)).resolves.toEqual({revision:1});
    vi.mocked(f.adapter.call).mockClear();
    await expect(f.manager.readCalibration('root',{...view,identity:'changed'})).rejects.toThrow('ptz_source_changed');
    expect(f.adapter.call).not.toHaveBeenCalled();
  } finally { await f.manager.close(); }
});
it('shares a stable epoch across protocol aliases and fences every field-of-view command before dispatch', async () => {
  const motors:string[] = [], scopes:string[] = [];
  const aliases = ['onvif:unit','gb28181:unit'];
  for (const [index,protocol] of (['onvif','gb28181'] as const).entries()) {
    const f = fixture();
    f.adapter.protocol = protocol;
    f.adapter.resource = aliases[index]!;
    f.adapter.caps.pointCenter = true;
    const manager = new PtzManager(f.store,f.deps,[index ? [...aliases].reverse() : aliases]);
    try {
      const identity = (await manager.inspect('root')).identity!;
      const view = {identity,width:640,height:360};
      scopes.push((await manager.readCalibration('root',view)).scope);
      motors.push(vi.mocked(f.store.calibrationEpoch).mock.calls[0]![0]);
      vi.mocked(f.store.invalidateCalibration).mockImplementation(async motor => {
        expect(motor).toBe(motors[index]); f.log.push('epoch');
      });
      const {sessionId} = await manager.acquire('root','operator',identity);
      const zero = {pan:0,tilt:0,zoom:0};
      await manager.command('root',sessionId,'operator',1,{...zero,pan:0.2});
      expect(f.store.invalidateCalibration).not.toHaveBeenCalled();
      await manager.command('root',sessionId,'operator',2,{...zero,zoom:0.5});
      await expect(manager.readCalibration('root',view)).rejects.toThrow('ptz_calibration_busy');
      await manager.command('root',sessionId,'operator',3,zero,'preset');
      await manager.command('root',sessionId,'operator',4,zero,undefined,false,{x:0.1,y:0.3});
      expect(f.log.slice(-6)).toEqual(['epoch','move','epoch','move','epoch','move']);
      await manager.stop('root',sessionId,'operator');
      await expect(manager.readCalibration('root',view)).resolves.toHaveProperty('scope',scopes[index]);
    } finally { await manager.close(); }
  }
  expect(motors[0]).toBe(motors[1]);
  expect(scopes[0]).not.toBe(scopes[1]);
});
it('rejects history after an intervening zoom and permits a fresh visual-only lease', async () => {
  const f = fixture();
  let epoch = 0;
  vi.mocked(f.store.calibrationEpoch).mockImplementation(async () => epoch);
  vi.mocked(f.store.invalidateCalibration).mockImplementation(async () => { ++epoch; });
  try {
    const identity = (await f.manager.inspect('root')).identity!;
    const view = await f.manager.readCalibration('root',{identity,width:1920,height:1080});
    const zoom = await f.manager.acquire('root','window-b',identity);
    await f.manager.command('root',zoom.sessionId,'window-b',1,{pan:0,tilt:0,zoom:0.2});
    await f.manager.stop('root',zoom.sessionId,'window-b');
    f.log.length = 0;
    await expect(f.manager.acquire('root','window-a',identity,undefined,view.epoch))
      .rejects.toMatchObject({code:'ptz_calibration_stale',statusCode:409});
    expect(f.log).toEqual([]);
    vi.mocked(f.store.calibrationEpoch).mockClear();
    const fresh = await f.manager.acquire('root','window-a',identity);
    expect(fresh.sessionId).toBeTruthy();
    expect(f.store.calibrationEpoch).not.toHaveBeenCalled();
  } finally { await f.manager.close(); }
});
it('reserves the motor during the epoch read and keeps it through lease issuance', async () => {
  const f = fixture();
  try {
    const identity = (await f.manager.inspect('root')).identity!;
    let finish!: (epoch:number)=>void, started!: ()=>void;
    const held = new Promise<number>(resolve => {finish=resolve;});
    const reading = new Promise<void>(resolve => {started=resolve;});
    vi.mocked(f.store.calibrationEpoch).mockImplementationOnce(() => {started(); return held;});
    const request = f.manager.acquire('root','window-a',identity,undefined,0);
    await reading;
    try { await expect(f.manager.acquire('root','window-b',identity)).rejects.toThrow('ptz_busy'); }
    finally { finish(0); }
    expect((await request).sessionId).toBeTruthy();
    await expect(f.manager.acquire('root','window-b',identity)).rejects.toThrow('ptz_busy');
  } finally { await f.manager.close(); }
});
it('a Stop overtaking a pending epoch commit prevents subsequent zoom dispatch', async () => {
  const f = fixture();
  try {
    const identity = (await f.manager.inspect('root')).identity!;
    const {sessionId} = await f.manager.acquire('root','operator',identity);
    let unlock!: () => void, started!: () => void;
    const pending = new Promise<void>(resolve => {unlock = resolve;});
    const reached = new Promise<void>(resolve => {started = resolve;});
    vi.mocked(f.store.invalidateCalibration).mockImplementation(async () => {started(); await pending;});
    const command = f.manager.command('root',sessionId,'operator',1,{pan:0,tilt:0,zoom:1});
    await reached;
    await f.manager.stop('root',sessionId,'operator');
    unlock();
    await expect(command).rejects.toThrow('ptz_stale_command');
    expect(f.log).not.toContain('move');
  } finally { await f.manager.close(); }
});
it('persists and confirms protection before any move and enforces ownership', async () => {
  const f = fixture();
  try {
    const inspected = await f.manager.inspect('root');
    const lease = await f.manager.acquire('root', 'operator', inspected.identity!);
    expect(f.log).toEqual(['stop', 'persist-block', 'confirmed-pause', 'tracking-reset']);
    await expect(
      f.manager.command('root', lease.sessionId, 'other', 1, { pan: 1, tilt: 0, zoom: 0 }),
    ).rejects.toThrow('ptz_session_expired');
    await f.manager.command('root', lease.sessionId, 'operator', 1, { pan: 1, tilt: 0, zoom: 0 });
    expect(f.log.at(-1)).toBe('move');
    await f.manager.stop('root', lease.sessionId, 'operator');
    await expect(
      f.manager.command('root', lease.sessionId, 'operator', 2, { pan: 1, tilt: 0, zoom: 0 }),
    ).rejects.toThrow('ptz_session_expired');
  } finally {
    await f.manager.close();
  }
});
it('refuses movement if rule pause is not confirmed', async () => {
  const f = fixture();
  f.deps.synchronize.mockResolvedValue({ state: 'pending' });
  try {
    const i = await f.manager.inspect('root');
    await expect(f.manager.acquire('root', 'operator', i.identity!)).rejects.toThrow(
      'ptz_arming_pause_pending',
    );
    expect(f.log).not.toContain('move');
  } finally {
    await f.manager.close();
  }
});
it('stops captured original target when the source changes', async () => {
  const f = fixture();
  try {
    const i = await f.manager.inspect('root');
    const l = await f.manager.acquire('root', 'operator', i.identity!);
    await f.manager.command('root', l.sessionId, 'operator', 1, { pan: 1, tilt: 0, zoom: 0 });
    f.root.inputGeneration = 'rebound';
    await expect(
      f.manager.command('root', l.sessionId, 'operator', 2, { pan: 1, tilt: 0, zoom: 0 }),
    ).rejects.toThrow('ptz_source_changed');
    expect(f.log.at(-1)).toBe('stop');
  } finally {
    await f.manager.close();
  }
});
it('does not treat delivery acceptance or incomplete position as restored view', () => {
  expect(samePtzPosition({}, {})).toBe(false);
  const p = { Pan: 0.1, Tilt: 0.2, Zoom: 0.3, PanTiltSpace: 'pan', ZoomSpace: 'zoom' };
  const before = { position: p };
  expect(samePtzPosition(before, { position: p, panTilt: 'IDLE', zoom: 'IDLE' })).toBe(true);
  expect(
    samePtzPosition(before, { position: { ...p, Zoom: 0.4 }, panTilt: 'IDLE', zoom: 'IDLE' }),
  ).toBe(false);
  expect(samePtzPosition(before, { position: p, panTilt: 'MOVING', zoom: 'IDLE' })).toBe(false);
});

it('shared-node video sources pause every processor but exclude another motor', async () => {
  const f = fixture();
  f.root.onvif = {
    deviceId: 'nvr',
    deviceVersion: 1,
    service: 'media1',
    profileToken: 'main',
    videoSource: 'sensor-a',
  };
  const sub = {
    ...f.root,
    id: 'sub',
    streamName: 'sub',
    onvif: { ...f.root.onvif, profileToken: 'sub', videoSource: 'sensor-b' },
  };
  const other = {
    ...f.root,
    id: 'other',
    streamName: 'other',
    onvif: { ...f.root.onvif, profileToken: 'other', videoSource: 'sensor-c' },
  };
  f.adapter.videoSources = ['sensor-a', 'sensor-b'];
  f.deps.channels.mockResolvedValue([f.root, sub, other]);
  try {
    const i = await f.manager.inspect('root');
    await f.manager.acquire('root', 'operator', i.identity!);
    expect(f.store.block).toHaveBeenCalledWith('motor-1', ['root', 'sub'], 'operator', null);
    expect(f.store.camera).toHaveBeenCalledWith('onvif:nvr/sensor-b', 'onvif:nvr/sensor-b');
  } finally {
    await f.manager.close();
  }
});
it('another main/sub profile cannot bypass the shared camera disable', async () => {
  const f = fixture();
  f.root.onvif = {
    deviceId: 'nvr',
    deviceVersion: 1,
    service: 'media1',
    profileToken: 'main',
    videoSource: 'sensor-a',
  };
  f.adapter.videoSources = ['sensor-a', 'sensor-b'];
  vi.mocked(f.store.camera).mockImplementation(async (key) => ({
    revision: 1,
    settings: { enabled: key !== 'onvif:nvr/sensor-b', panTilt: null, zoom: null, presets: null },
  }));
  try {
    const i = await f.manager.inspect('root');
    expect(i.enabled).toBe(false);
    await expect(f.manager.acquire('root', 'operator', i.identity!)).rejects.toThrow(
      'ptz_disabled',
    );
  } finally {
    await f.manager.close();
  }
});
it('preset administration cannot steal another operator control', async () => {
  const f = fixture();
  try {
    const i = await f.manager.inspect('root');
    const l = await f.manager.acquire('root', 'operator', i.identity!);
    await f.manager.command('root', l.sessionId, 'operator', 1, { pan: 1, tilt: 0, zoom: 0 });
    const calls = vi.mocked(f.adapter.call).mock.calls.length;
    await expect(
      f.manager.savePreset('root', 'other', { name: 'Gate', shortcut: 1 }),
    ).rejects.toThrow('ptz_busy');
    await expect(f.manager.removePreset('root', 'other', 'gate')).rejects.toThrow('ptz_busy');
    expect(vi.mocked(f.adapter.call).mock.calls).toHaveLength(calls);
  } finally {
    await f.manager.close();
  }
});
it('edits only reported native preset metadata, scoped to its resource and physical motor group', async () => {
  const f = fixture();
  const group = ['gb28181:device/channel','onvif:motor'];
  f.adapter.resource = group[1]!;
  const manager = new PtzManager(f.store, f.deps, [group]);
  const input = {name:'后门', shortcut:2};
  const edit = () => manager.updatePresetMetadata('root','operator','native-8',input);
  try {
    vi.mocked(f.adapter.call).mockResolvedValue([{id:'native-8',name:'old'}]);
    await expect(edit()).resolves.toEqual({id:'native-8',...input});
    expect(f.store.updatePresetMetadata).toHaveBeenCalledWith(group[1],'native-8','后门',2,'operator',group);
    vi.mocked(f.adapter.call).mockResolvedValueOnce([]);
    await expect(edit()).rejects.toThrow('ptz_preset_not_found');
    vi.mocked(f.adapter.call).mockRejectedValueOnce(Error('offline'));
    await expect(edit()).rejects.toThrow('ptz_preset_query_required');
    f.adapter.caps.presetWrite = false;
    await expect(edit()).rejects.toThrow('ptz_presets_unsupported');
    expect(vi.mocked(f.adapter.call).mock.calls.map(([op])=>op)).toEqual(['presets','presets','presets']);
    expect(f.store.updatePresetMetadata).toHaveBeenCalledTimes(1);
    expect(f.store.savePreset).not.toHaveBeenCalled();
    expect(f.store.block).not.toHaveBeenCalled();
  } finally { await manager.close(); }
});
it('device-accepted preset with failed metadata is reported as partial success', async () => {
  const f = fixture();
  vi.mocked(f.adapter.call).mockResolvedValue({ id: 'native-gate' });
  vi.mocked(f.store.savePreset).mockRejectedValue(Error('database unavailable'));
  try {
    await expect(
      f.manager.savePreset('root', 'operator', { name: 'Gate', shortcut: 1 }),
    ).rejects.toThrow('ptz_preset_device_saved_metadata_failed');
  } finally {
    await f.manager.close();
  }
});
it('concurrent preset operations are serialized with control acquisition', async () => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  vi.mocked(f.adapter.call).mockImplementation(async (action) =>
    action === 'preset-save'
      ? await new Promise((resolve) => {
          finish = resolve;
        })
      : { stopConfirmed: true },
  );
  try {
    const saving = f.manager.savePreset('root', 'operator', { name: 'Gate', shortcut: 1 });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const i = await f.manager.inspect('root');
    await expect(f.manager.acquire('root', 'operator', i.identity!)).rejects.toThrow('ptz_busy');
    finish({ id: 'gate' });
    await saving;
  } finally {
    await f.manager.close();
  }
});
it('restart recovery stops only a recorded local unfinished control', async () => {
  const f = fixture();
  vi.mocked(f.store.guards).mockResolvedValue([
    {
      resource_key: 'motor-1',
      blocked: true,
      stop_pending: true,
      source_ids: ['root'],
      revision: 3,
    },
  ]);
  vi.mocked(f.store.guard).mockResolvedValue({revision:3,stop_pending:true} as never);
  try {
    await f.manager.observe();
    expect(f.adapter.call).toHaveBeenCalledWith(
      'command',
      expect.objectContaining({
        command: expect.objectContaining({ stop: true, emergency: true }),
      }),
    );
    expect(f.store.stopped).toHaveBeenCalledWith('motor-1', 3);
    expect(f.store.block).not.toHaveBeenCalled();
  } finally {
    await f.manager.close();
  }
});
it('external motion suspends analytics without taking over external control', async () => {
  const f = fixture();
  f.root.onvif = {
    deviceId: 'nvr',
    deviceVersion: 1,
    service: 'media1',
    profileToken: 'main',
    videoSource: 'sensor-a',
  };
  f.adapter.caps.position = true;
  f.adapter.caps.moveStatus = true;
  const position = { Pan: 0.1, Tilt: 0.2, Zoom: 0.3, PanTiltSpace: 'pan', ZoomSpace: 'zoom' };
  vi.mocked(f.store.guards).mockResolvedValue([
    {
      resource_key: 'motor-1',
      blocked: false,
      stop_pending: false,
      source_ids: ['root'],
      revision: 1,
      baseline: { position },
    },
  ]);
  vi.mocked(f.adapter.call).mockResolvedValue({
    position: { ...position, Pan: 0.4 },
    panTilt: 'MOVING',
    zoom: 'IDLE',
  });
  try {
    await f.manager.observe();
    expect(f.store.block).toHaveBeenCalledWith(
      'motor-1',
      ['root'],
      'ptz-external-motion',
      { position },
      false,
    );
    expect(f.deps.resetProcessors).toHaveBeenCalled();
    expect(vi.mocked(f.adapter.call).mock.calls.map((c) => c[0])).toEqual(['status']);
  } finally {
    await f.manager.close();
  }
});
it('unknown feedback and a disconnected device never clear a persistent view guard', async () => {
  const f = fixture();
  vi.mocked(f.store.guards).mockResolvedValue([
    {
      resource_key: 'motor-1',
      blocked: true,
      stop_pending: true,
      source_ids: ['root'],
      revision: 3,
    },
  ]);
  vi.mocked(f.store.guard).mockResolvedValue({revision:3,stop_pending:true} as never);
  vi.mocked(f.adapter.call).mockRejectedValue(Error('offline'));
  try {
    await f.manager.observe();
    expect(f.store.stopped).not.toHaveBeenCalled();
    expect(f.store.block).not.toHaveBeenCalled();
  } finally {
    await f.manager.close();
  }
});
it('zoom-only status can restore a view while incomplete or moving status cannot', () => {
  const position = { Zoom: 0.3, ZoomSpace: 'zoom' };
  expect(samePtzPosition({ position }, { position, zoom: 'IDLE' })).toBe(true);
  expect(samePtzPosition({ position }, { position, zoom: 'MOVING' })).toBe(false);
  expect(samePtzPosition({ position }, { position: {}, zoom: 'IDLE' })).toBe(false);
});

it('rearming stores the new view baseline instead of immediately invalidating it again', async () => {
  const f = fixture();
  f.adapter.caps.position = true;
  const old = {
    position: { Pan: 0.1, Tilt: 0.2, Zoom: 0.3, PanTiltSpace: 'pan', ZoomSpace: 'zoom' },
  };
  const current = { position: { ...old.position, Pan: 0.8 }, panTilt: 'IDLE', zoom: 'IDLE' };
  vi.mocked(f.store.guard).mockResolvedValue({
    revision: 1,
    blocked: true,
    baseline: old,
    source_ids: ['root'],
    changed_at: '2026-10-27T00:00:00Z',
  });
  vi.mocked(f.adapter.call).mockImplementation(async (action) =>
    action === 'status' ? current : { stopConfirmed: true },
  );
  try {
    await f.manager.restoreView('root', 'operator', 1, 'rearmed');
    expect(f.store.restore).toHaveBeenCalledWith('motor-1', 1, 'operator', current, expect.any(Function));
  } finally {
    await f.manager.close();
  }
});

it('brakes the admitted motor without discovery or guard storage and never acknowledges an unconfirmed stop', async () => {
  const f = fixture();
  try {
    const identity = (await f.manager.inspect('root')).identity!;
    const {sessionId} = await f.manager.acquire('root','operator',identity);
    await f.manager.command('root',sessionId,'operator',1,{pan:.2,tilt:0,zoom:0});
    f.deps.ai.mockRejectedValue(Error('analytics offline'));
    const wire = Promise.withResolvers<{stopConfirmed:boolean}>();
    vi.mocked(f.adapter.call).mockClear().mockReturnValueOnce(wire.promise);
    vi.mocked(f.store.block).mockRejectedValue(Error('guard offline'));
    const emergency = f.manager.emergencyStop('root','operator');
    const second = f.manager.emergencyStop('root','operator');
    const release = f.manager.stop('root',sessionId,'operator');
    const outcomes = Promise.allSettled([emergency,second,release]);
    await vi.waitFor(() => expect(f.adapter.call).toHaveBeenCalledExactlyOnceWith('command',{
      command:expect.objectContaining({stop:true,emergency:true}),
    }));
    wire.resolve({stopConfirmed:false});
    for (const value of await outcomes) {
      expect(value).toMatchObject({status:'rejected',reason:{code:'ptz_stop_unconfirmed'}});
    }
    await expect(f.manager.emergencyStop('root','operator')).rejects.toThrow('ptz_arming_pause_pending');
    expect(f.adapter.call).toHaveBeenCalledTimes(2);
  } finally { await f.manager.close(); }
});
it('rejects moves from a disabled derived channel while retaining the ability to release its lease', async () => {
  const f = fixture();
  const derived = {...f.root,id:'derived',streamName:'derived',onvif:undefined,inputEnabled:true};
  f.deps.channels.mockResolvedValue([f.root,derived]);
  f.deps.ai.mockResolvedValue([{id:'processor',config:{stream:{url:'rtmp://127.0.0.1/live/gate'},
    publish:{enabled:true,target_url:'rtmp://127.0.0.1/live/derived'}}}] as never);
  try {
    const identity = (await f.manager.inspect('derived')).identity!;
    const {sessionId} = await f.manager.acquire('derived','operator',identity);
    await f.manager.command('derived',sessionId,'operator',1,{pan:.2,tilt:0,zoom:0});
    derived.inputEnabled=false;
    vi.mocked(f.adapter.call).mockClear();
    await expect(f.manager.command('derived',sessionId,'operator',2,{pan:.2,tilt:0,zoom:0})).rejects.toThrow('ptz_source_changed');
    expect(f.adapter.call).toHaveBeenCalledExactlyOnceWith('command',{command:expect.objectContaining({stop:true})});
    await expect(f.manager.stop('derived',sessionId,'operator')).resolves.toMatchObject({stopConfirmed:true});
    await expect(f.manager.acquire('derived','operator',identity)).rejects.toThrow('ptz_source_changed');
    expect(f.adapter.call).toHaveBeenCalledTimes(1);
  } finally { await f.manager.close(); }
});
it('brakes a running command on lost verification but ignores an obsolete verification failure', async () => {
  const f=fixture(), vector={pan:.2,tilt:0,zoom:0};
  try {
    const identity=(await f.manager.inspect('root')).identity!;
    const {sessionId}=await f.manager.acquire('root','operator',identity);
    const command=(seq:number)=>f.manager.command('root',sessionId,'operator',seq,vector);
    await command(1);
    const late=Promise.withResolvers<never>();
    f.deps.ai.mockReturnValueOnce(late.promise);
    const old=expect(command(2)).rejects.toThrow('ptz_stale_command');
    await command(3);
    vi.mocked(f.adapter.call).mockClear();
    late.reject(Error('discovery unavailable'));
    await old;
    expect(f.adapter.call).not.toHaveBeenCalled();
    f.deps.ai.mockRejectedValueOnce(Error('discovery unavailable'));
    await expect(command(4)).rejects.toThrow('discovery unavailable');
    expect(f.adapter.call).toHaveBeenCalledExactlyOnceWith('command',{command:expect.objectContaining({stop:true})});
  } finally { await f.manager.close(); }
});
it('a late failed session Stop cannot undo a confirmed priority Stop', async () => {
  const f=fixture();
  try {
    const identity=(await f.manager.inspect('root')).identity!;
    const {sessionId}=await f.manager.acquire('root','operator',identity);
    await f.manager.command('root',sessionId,'operator',1,{pan:.2,tilt:0,zoom:0});
    const old=Promise.withResolvers<never>();
    vi.mocked(f.adapter.call).mockClear().mockReturnValueOnce(old.promise);
    const released=f.manager.stop('root',sessionId,'operator');
    await expect(f.manager.emergencyStop('root','operator')).resolves.toMatchObject({stopConfirmed:true});
    old.reject(Error('old session gone'));
    await expect(released).resolves.toMatchObject({stopConfirmed:true});
    expect((await f.manager.inspect('root')).stopUnconfirmed).toBe(false);
    expect(f.adapter.call).toHaveBeenCalledTimes(2);
  } finally { await f.manager.close(); }
});
it('emergency Stop cancels an acquisition waiting for analytics readiness', async () => {
  const f = fixture();
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.deps.resetProcessors.mockImplementation(() => ready);
  const info = await f.manager.inspect('root');
  const acquiring = f.manager.acquire('root', 'operator', info.identity!);
  const rejected = expect(acquiring).rejects.toThrow('ptz_session_expired');
  await vi.waitFor(() => expect(f.deps.resetProcessors).toHaveBeenCalled());
  await f.manager.emergencyStop('root', 'operator');
  finish();
  await rejected;
  expect((await f.manager.inspect('root')).busy).toBe(false);
  expect(f.log).not.toContain('move');
  await f.manager.close();
});

it('stopping a successful acquisition with no issued movement restores only its own new pause', async () => {
  const f = fixture();
  vi.mocked(f.store.block).mockResolvedValue(7);
  try {
    const info = await f.manager.inspect('root');
    const lease = await f.manager.acquire('root', 'operator', info.identity!);
    await f.manager.stop('root', lease.sessionId, 'operator');
    expect(f.store.restore).toHaveBeenCalledWith('motor-1', 7, 'operator', null);
    expect(f.deps.synchronize).toHaveBeenCalledTimes(2);
    expect(f.log).not.toContain('move');
  } finally {
    await f.manager.close();
  }
});
it('an unused control lease never restores a pause that existed before acquisition', async () => {
  const f = fixture();
  vi.mocked(f.store.guard).mockResolvedValue({ blocked: true, baseline: { old: true } } as never);
  vi.mocked(f.store.block).mockResolvedValue(8);
  try {
    const info = await f.manager.inspect('root');
    const lease = await f.manager.acquire('root', 'operator', info.identity!);
    await f.manager.stop('root', lease.sessionId, 'operator');
    expect(f.store.restore).not.toHaveBeenCalled();
  } finally {
    await f.manager.close();
  }
});

it('unsupported analytics reset is rejected before pausing any rules', async () => {
  const f = fixture();
  (f.deps as any).checkProcessors = vi.fn(async () => {
    throw Error('ptz_tracking_reset_unsupported');
  });
  try {
    const info = await f.manager.inspect('root');
    await expect(f.manager.acquire('root', 'operator', info.identity!)).rejects.toThrow(
      'ptz_tracking_reset_unsupported',
    );
    expect(f.store.block).not.toHaveBeenCalled();
    expect(f.deps.resetProcessors).not.toHaveBeenCalled();
  } finally {
    await f.manager.close();
  }
});

it('exposes persistent protection without depending on a live AI service', async () => {
  const f = fixture();
  f.deps.ai.mockRejectedValue(Error('AI offline'));
  vi.mocked(f.store.guards).mockResolvedValue([
    {
      blocked: true,
      stop_pending: true,
      source_ids: ['root'],
      actor: 'ptz-external-motion',
      changed_at: '2026-10-27T08:00:00Z',
    },
  ] as never);
  const result = await f.manager.protection();
  expect(result.items[0]).toMatchObject({
    source: { id: 'root', name: 'Gate' },
    reason: 'external_motion',
    blocked: true,
    stopPending: true,
  });
  expect(f.deps.ai).not.toHaveBeenCalled();
  await f.manager.close();
});

it('a failed reset keeps protection and reports its paused state instead of a generic acquisition failure', async () => {
  const f = fixture();
  f.deps.resetProcessors.mockRejectedValue(Error('transport failed'));
  try {
    const info = await f.manager.inspect('root');
    await expect(f.manager.acquire('root', 'operator', info.identity!)).rejects.toThrow(
      'ptz_tracking_reset_pending',
    );
    expect(f.store.block).toHaveBeenCalled();
    expect(f.store.restore).not.toHaveBeenCalled();
    expect(f.log).not.toContain('move');
  } finally {
    await f.manager.close();
  }
});

for (const feedback of ['IDLE', 'MOVING', 'UNKNOWN', 'missing', 'error']) {
  it(`preset releases early only after repeated explicit idle: ${feedback}`, async () => {
    const f = fixture();
    f.adapter.caps.moveStatus = true;
    const original = f.adapter.call;
    f.adapter.call = async (action, body) => {
      if (action === 'status') {
        if (feedback === 'error') throw Error('offline');
        return feedback === 'missing' ? {} : { panTilt: feedback, zoom: feedback };
      }
      return original(action, body);
    };
    let now = 100000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const info = await f.manager.inspect('root');
      const lease = await f.manager.acquire('root', 'operator', info.identity!);
      const zero = { pan: 0, tilt: 0, zoom: 0 };
      await f.manager.command('root', lease.sessionId, 'operator', 1, zero, 'gate');
      now += 1000;
      const first = await f.manager.command(
        'root',
        lease.sessionId,
        'operator',
        2,
        zero,
        undefined,
        true,
      );
      expect(first.motionFinished).not.toBe(true);
      now += 600;
      const second = await f.manager.command(
        'root',
        lease.sessionId,
        'operator',
        3,
        zero,
        undefined,
        true,
      );
      expect(second.motionFinished === true).toBe(feedback === 'IDLE');
      // Finishing a preset never automatically validates the old armed view.
      expect(f.store.restore).not.toHaveBeenCalled();
    } finally {
      await f.manager.close();
      clock.mockRestore();
    }
  });
}

it('arbitrates confirmed ONVIF and GB aliases even for two windows with the same login', async () => {
  const f = fixture();
  const gbRoot = {...f.root, id:'gb', onvif:undefined, upstreamProtocol:'rtmp' as const};
  const gb = {...f.adapter, resource:'gb28181:device/channel', protocol:'gb28181' as const,
    identity:JSON.stringify(['binding','device','channel']), call:vi.fn(async () => ({stopConfirmed:true}))};
  f.adapter.resource = 'onvif:motor';
  f.deps.channels.mockResolvedValue([f.root,gbRoot]);
  const manager = new PtzManager(f.store, {...f.deps, prepare:async root => root.id === 'gb' ? gb : f.adapter},
    [[f.adapter.resource,gb.resource]]);
  try {
    const first = await manager.inspect('root');
    const lease = await manager.acquire('root','same-login', first.identity!);
    const alias = await manager.inspect('gb');
    expect(alias.busy).toBe(true);
    await expect(manager.acquire('gb','same-login',alias.identity!)).rejects.toThrow('ptz_busy');
    await expect(manager.removePreset('gb','same-login','1')).rejects.toThrow('ptz_busy');
    await expect(manager.updatePresetMetadata('gb','same-login','7',{name:'alias',shortcut:null})).rejects.toThrow('ptz_busy');
    expect(gb.call).not.toHaveBeenCalled();
    await manager.stop('root',lease.sessionId,'same-login');
    const second = await manager.acquire('gb','same-login',alias.identity!);
    await expect(manager.stop('root',lease.sessionId,'same-login')).rejects.toThrow('ptz_session_expired');
    expect((await manager.inspect('root')).busy).toBe(true);
    await manager.stop('gb',second.sessionId,'same-login');
  } finally {await manager.close();}
});
