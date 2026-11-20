import Fastify from 'fastify';
import { it, expect, vi } from 'vitest';
import { ptzRoutes } from '../routes/ptz.js';
import type { PtzFlow } from '../services/ptzFlow.js';
import type { PtzManager } from '../services/ptzManager.js';
import { PtzError, type PtzStore } from '../store/ptzStore.js';
const id = '11111111-1111-4111-8111-111111111111',
  session = '22222222-2222-4222-8222-222222222222';
function fixture(auth = true) {
  const flow = {measure:vi.fn(async (_frames, check) => { await check(); return {dx:1}; })};
  const manager = {
    checkFlowContext: vi.fn(async () => undefined),
    close: vi.fn(),
    readCalibration: vi.fn(async () => ({scope:'b'.repeat(64), epoch:0, revision:0, zoomEvidence:'unknown', snapshot:null})),
    writeCalibration: vi.fn(async () => ({revision:1})),
    command: vi.fn(async () => ({ moving: true })),
    updatePresetMetadata: vi.fn(async (_id: string, _actor: string, preset: string,
      input: {name:string; shortcut:number|null}) => ({id:preset,...input})),
    emergencyStop: vi.fn(async () => ({ stopConfirmed: true })),
    inspect: vi.fn(async () => ({ supported: true })),
    catalog: vi.fn(async () => ({ items: [] })),
    acquire: vi.fn(async () => ({ sessionId: session })),
    invalidateCamera: vi.fn(async () => ({ state: 'applied' })),
  } as unknown as PtzManager;
  const store = {
    pool: { query: vi.fn(async () => ({ rows: [{ exists: 1 }] })) },
    camera: vi.fn(async () => ({
      revision: 0,
      settings: { enabled: true, panTilt: null, zoom: null, presets: null },
    })),
  } as unknown as PtzStore;
  const app = Fastify();
  app.register(ptzRoutes, {
    manager,
    flow: flow as unknown as PtzFlow,
    store,
    principal: async () => (auth ? 'operator' : null),
    channels: async () => [],
  });
  return { app, manager, store, flow };
}
it('authenticates and validates both fixed-size JPEGs and forwards only a bounded pair', async () => {
  const header = Buffer.from('ffd8ffc00011080180020003011100021100031100','hex');
  const jpeg = (size: number) => Buffer.concat([header,Buffer.alloc(size-header.length-2),Buffer.from([255,217])]).toString('base64');
  const small = jpeg(32), max = jpeg(2*1024*1024);
  const body = {identity:'c'.repeat(64),epoch:0,frame0:small,frame1:small};
  const url = `/channels/${id}/ptz/flow`;
  for (const auth of [false,true]) {
    const f = fixture(auth);
    const post = (payload:object) => f.app.inject({method:'POST',url,payload});
    try {
      if (!auth) {
        expect((await post(body)).statusCode).toBe(401);
        expect(f.flow.measure).not.toHaveBeenCalled();
        continue;
      }
      const wrong = Buffer.from(small,'base64'); wrong[8] = 1;
      for (const patch of [{frame0:wrong.toString('base64')},{frame1:'data:image/jpeg;base64,'+small},
        {frame0:jpeg(2*1024*1024+1)},{frame1:small+'\n'},{frame0:'a==='},{identity:'stale'},{epoch:-1},
        {url:'http://example.invalid'},{token:'browser-supplied'}]) {
        expect((await post({...body,...patch})).statusCode).toBe(400);
      }
      expect((await post({...body,frame0:max+'A'.repeat(2048),frame1:max})).statusCode).toBe(413);
      for (const [type,status] of [['application/json',400],['application/octet-stream',415]] as const) {
        const invalid=await f.app.inject({method:'POST',url,headers:{'content-type':type},payload:'{'});
        expect(invalid.statusCode).toBe(status);
        expect(invalid.json()).toEqual({error:'ptz_flow_invalid'});
      }
      expect(f.flow.measure).not.toHaveBeenCalled();
      expect((await post({...body,frame0:max,frame1:max})).statusCode).toBe(200);
      expect(f.flow.measure.mock.calls[0]![0]).toEqual({frame0:max,frame1:max});
      expect(f.manager.checkFlowContext).toHaveBeenCalledWith(id,body.identity,0);
      vi.mocked(f.manager.checkFlowContext).mockRejectedValue(new PtzError('ptz_calibration_stale'));
      expect((await post(body)).json()).toEqual({error:'ptz_calibration_stale'});
    } finally { await f.app.close(); }
  }
});
it('accepts only the versioned optional estimator on both calibration operations', async () => {
  const f = fixture(), view = {identity:'a'.repeat(64),width:512,height:384,estimator:'neuflow-v1'};
  try {
    const url = `/channels/${id}/ptz/center-calibration`;
    const write = {...view,scope:'f'.repeat(64),revision:0,epoch:1,snapshot:{version:1,records:[]}};
    for (const [path,method,payload] of [[url+'/read','POST',view],[url,'PUT',write]] as const) {
      expect((await f.app.inject({url:path,method,payload})).statusCode).toBe(200);
      expect((await f.app.inject({url:path,method,payload:{...payload,estimator:'other'}})).statusCode).toBe(400);
    }
    expect(f.manager.readCalibration).toHaveBeenCalledWith(id,view);
    expect(f.manager.writeCalibration).toHaveBeenCalledWith(id,write);
  } finally { await f.app.close(); }
});
it('PTZ administration requires authentication and never probes a camera before it', async () => {
  const f = fixture(false);
  try {
    const r = await f.app.inject({
      url: '/ptz/camera-configurations',
      method: 'POST',
      payload: { sources: [{ protocol: 'onvif', deviceId: id, videoSource: 'sensor' }] },
    });
    expect(r.statusCode).toBe(401);
    expect(f.store.pool.query).not.toHaveBeenCalled();
    expect((await f.app.inject(`/channels/${id}/ptz`)).statusCode).toBe(401);
  } finally {
    await f.app.close();
  }
});
it('uses control authentication and validates the calibration wire contract before device access', async () => {
  const view = {identity:'a'.repeat(64), width:1920, height:1080};
  const record = {axis:'pan', sign:-1, speed:0.2, durationMs:160, displacement:0.1, at:123};
  const write = {...view, scope:'b'.repeat(64), epoch:0, revision:0, snapshot:{version:1, records:[record]}};
  const url = `/channels/${id}/ptz/center-calibration`;
  for (const auth of [false,true]) {
    const f = fixture(auth);
    try {
      const read = await f.app.inject({method:'POST',url:url+'/read',payload:view});
      const saved = await f.app.inject({method:'PUT',url,payload:write});
      expect([read.statusCode,saved.statusCode]).toEqual(auth ? [200,200] : [401,401]);
      if (!auth) {
        expect(f.manager.readCalibration).not.toHaveBeenCalled();
        expect(f.manager.writeCalibration).not.toHaveBeenCalled();
        continue;
      }
      expect(saved.json()).toEqual({revision:1});
      for (const payload of [{...write,width:0}, {...write,height:16385}, {...write,epoch:-1},
        {...write,snapshot:{version:2,records:[]}}, {...write,snapshot:{version:1,records:Array(7).fill(record)}},
        ...[{at:0},{durationMs:1251},{displacement:0},{speed:0.079},{extra:1}].map(over =>
          ({...write,snapshot:{version:1,records:[{...record,...over}]}}))])
        expect((await f.app.inject({method:'PUT',url,payload})).statusCode).toBe(400);
      expect(f.manager.writeCalibration).toHaveBeenCalledTimes(1);
      expect(f.manager.command).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  }
});
it('strict controls reject arbitrary addresses, credentials, malformed sessions and vectors', async () => {
  const f = fixture();
  try {
    for (const payload of [
      { sequence: 1, vector: { pan: 2, tilt: 0, zoom: 0 } },
      { sequence: 1, vector: { pan: 1, tilt: 0, zoom: 0 }, url: 'http://camera' },
      { sequence: 0, vector: { pan: 1, tilt: 0, zoom: 0 } },
    ])
      expect(
        (
          await f.app.inject({
            url: `/channels/${id}/ptz/control-session/${session}`,
            method: 'PUT',
            payload,
          })
        ).statusCode,
      ).toBe(400);
    expect(f.manager.command).not.toHaveBeenCalled();
    const r = await f.app.inject({
      url: `/channels/${id}/ptz/control-session/${session}`,
      method: 'PUT',
      payload: { sequence: 1, vector: { pan: 1, tilt: 0, zoom: 0 } },
    });
    expect(r.statusCode).toBe(200);
    expect(f.manager.command).toHaveBeenCalledWith(
      id,
      session,
      'operator',
      1,
      { pan: 1, tilt: 0, zoom: 0 },
      undefined,
      undefined,
    );
  } finally {
    await f.app.close();
  }
});
it('offline camera settings use stable protocol identity and bounded selections', async () => {
  const f = fixture();
  try {
    const r = await f.app.inject({
      url: '/ptz/camera-configurations',
      method: 'POST',
      payload: { sources: [{ protocol: 'onvif', deviceId: id, videoSource: 'sensor-a' }] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().items[0].key).toBe(`onvif:${id}/sensor-a`);
    expect(f.manager.inspect).not.toHaveBeenCalled();
    const invalid = await f.app.inject({
      url: '/ptz/camera-configurations',
      method: 'POST',
      payload: {
        sources: Array.from({ length: 101 }, () => ({
          protocol: 'onvif',
          deviceId: id,
          videoSource: 'sensor-a',
        })),
      },
    });
    expect(invalid.statusCode).toBe(400);
  } finally {
    await f.app.close();
  }
});
it('accepts optional safe calibration epochs for manual acquire and reports stale separately', async () => {
  const f = fixture();
  const identity = 'a'.repeat(64), url = `/channels/${id}/ptz/control-session`;
  try {
    for (const calibrationEpoch of [undefined, 0, 5]) {
      expect((await f.app.inject({method:'POST',url,payload:{identity,calibrationEpoch}})).statusCode).toBe(200);
      expect(f.manager.acquire).toHaveBeenLastCalledWith(id,'operator',identity,undefined,calibrationEpoch);
    }
    for (const calibrationEpoch of [-1, 1.5, 2 ** 53, '0', null])
      expect((await f.app.inject({method:'POST',url,payload:{identity,calibrationEpoch}})).statusCode).toBe(400);
    vi.mocked(f.manager.acquire).mockRejectedValueOnce(new PtzError('ptz_calibration_stale'));
    const response = await f.app.inject({method:'POST',url,payload:{identity,calibrationEpoch:0}});
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({error:'ptz_calibration_stale'});
  } finally { await f.app.close(); }
});
it('emergency Stop is a separate explicit authenticated operation', async () => {
  const f = fixture();
  try {
    const r = await f.app.inject({
      url: `/channels/${id}/ptz/stop`,
      method: 'POST',
      payload: { sessionId: null },
    });
    expect(r.statusCode).toBe(200);
    expect(f.manager.emergencyStop).toHaveBeenCalledWith(id, 'operator');
  } finally {
    await f.app.close();
  }
});
it('authenticates and strictly validates metadata-only preset edits', async () => {
  const url = `/channels/${id}/ptz/presets/native-8`;
  const input = { name: ' North ', shortcut: null };
  for (const auth of [false, true]) {
    const f = fixture(auth);
    try {
      const r = await f.app.inject({method:'PUT', url, payload:input});
      expect(r.statusCode).toBe(auth ? 200 : 401);
      if (!auth) { expect(f.manager.updatePresetMetadata).not.toHaveBeenCalled(); continue; }
      expect(r.json()).toEqual({id:'native-8',name:'North',shortcut:null});
      expect(f.manager.updatePresetMetadata).toHaveBeenCalledWith(id,'operator','native-8',{name:'North',shortcut:null});
      for (const payload of [{name:'North'}, {...input,name:' '}, {...input,shortcut:0}, {...input,id:'other'}])
        expect((await f.app.inject({method:'PUT',url,payload})).statusCode).toBe(400);
      expect(f.manager.updatePresetMetadata).toHaveBeenCalledTimes(1);
      expect(f.manager.command).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  }
});
