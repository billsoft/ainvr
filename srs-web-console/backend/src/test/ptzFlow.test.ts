import { afterEach, expect, it, vi } from 'vitest';
import { PtzFlow } from '../services/ptzFlow.js';
import { PtzError } from '../store/ptzStore.js';

const config = {baseUrl:'http://127.0.0.1:8000', apiToken:'t'.repeat(32), timeoutMs:17_000};
const frames = {frame0:'first',frame1:'second'};
const motion = {dx:-2.5,dy:0.25,width:512,height:384,backend:'neuflow-bpu',inliers:120,
  validRatio:120/(512*384),spread:1};
const ok = () => Response.json({...motion,provenance:{native:true}});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('sends only the ordered frame pair with the internal token and fences the result', async () => {
  const wire = vi.fn(async () => ok());
  vi.stubGlobal('fetch',wire);
  const client = new PtzFlow(async () => config), check = vi.fn(async () => {});
  expect(await client.measure(frames,check)).toEqual(motion);
  expect(check).toHaveBeenCalledTimes(2);
  expect(wire).toHaveBeenCalledWith(new URL('/internal/ptz/flow',config.baseUrl),{
    method:'POST', redirect:'error', signal:expect.any(AbortSignal),
    headers:{'x-service-token':config.apiToken,'content-type':'application/json'}, body:JSON.stringify(frames),
  });
  check.mockRejectedValueOnce(new PtzError('ptz_source_changed'));
  await expect(client.measure(frames,check)).rejects.toThrow('ptz_source_changed');
  expect(wire).toHaveBeenCalledTimes(1);
  check.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new PtzError('ptz_calibration_stale'));
  await expect(client.measure(frames,check)).rejects.toThrow('ptz_calibration_stale');
});

it('rejects overlapping requests immediately and reopens admission after completion', async () => {
  const entered = Promise.withResolvers<void>(), done = Promise.withResolvers<Response>();
  const wire = vi.fn(async () => {entered.resolve(); return done.promise;});
  vi.stubGlobal('fetch',wire);
  const client = new PtzFlow(async () => config), check = vi.fn(async () => {});
  const first = client.measure(frames,check);
  await entered.promise;
  await expect(client.measure(frames,check)).rejects.toMatchObject({code:'ptz_flow_busy',statusCode:429});
  expect(check).toHaveBeenCalledTimes(1);
  done.resolve(ok());
  await expect(first).resolves.toEqual(motion);
  wire.mockResolvedValueOnce(ok());
  await expect(client.measure(frames,check)).resolves.toEqual(motion);
});

it('allows a 4.41 second cold calibration response', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', () => new Promise<Response>(resolve => setTimeout(() => resolve(ok()), 4410)));
  const client = new PtzFlow(async () => config);
  const measured = expect(client.measure(frames, async () => {})).resolves.toEqual(motion);
  await vi.advanceTimersByTimeAsync(4410);
  await measured;
});

it('bounds time across context and native processing, with no delayed dispatch or retry', async () => {
  vi.useFakeTimers();
  const wire = vi.fn((_url:URL, {signal}:RequestInit) => new Promise<Response>((_,reject) => {
    signal!.addEventListener('abort',() => reject(signal!.reason),{once:true});
  }));
  vi.stubGlobal('fetch',wire);
  const client = new PtzFlow(async () => config), gate = Promise.withResolvers<void>();
  const first = expect(client.measure(frames,() => gate.promise)).rejects.toThrow('ptz_flow_unavailable');
  await vi.advanceTimersByTimeAsync(17_000);
  await first;
  await expect(client.measure(frames,async () => {})).rejects.toThrow('ptz_flow_busy');
  gate.resolve();
  await vi.advanceTimersByTimeAsync(1);
  expect(wire).not.toHaveBeenCalled();
  const second = expect(client.measure(frames,async () => {})).rejects.toThrow('ptz_flow_unavailable');
  await vi.advanceTimersByTimeAsync(16_999);
  expect(wire.mock.calls[0]![1].signal!.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await second;
  expect(wire).toHaveBeenCalledTimes(1);
  expect(wire.mock.calls[0]![1].signal!.aborted).toBe(true);
  wire.mockResolvedValueOnce(ok());
  await expect(client.measure(frames,async () => {})).resolves.toEqual(motion);
});

it('fails closed on native errors, credentials, destinations and malformed results', async () => {
  const wire = vi.fn(async () => ok());
  vi.stubGlobal('fetch',wire);
  const check = async () => {};
  for (const override of [{apiToken:''},{baseUrl:'http://example.invalid:8000'},{baseUrl:config.baseUrl+'/other'}])
    await expect(new PtzFlow(async () => ({...config,...override})).measure(frames,check)).rejects.toThrow('ptz_flow_unavailable');
  expect(wire).not.toHaveBeenCalled();
  const client = new PtzFlow(async () => config);
  for (const upstream of [new Response('private',{status:503}),new Response(null,{status:504}),
    new Response('not-json'),new Response('a'.repeat(16385)),Response.json({...motion,width:300}),
    Response.json({...motion,backend:'cpu'}),Response.json({...motion,validRatio:1.1})]) {
    wire.mockResolvedValueOnce(upstream);
    await expect(client.measure(frames,check)).rejects.toMatchObject({code:'ptz_flow_unavailable',statusCode:503});
  }
  wire.mockResolvedValueOnce(new Response(null,{status:429}));
  await expect(client.measure(frames,check)).rejects.toMatchObject({code:'ptz_flow_busy',statusCode:429});
  for (const [statusCode,code] of [[413,'ptz_flow_too_large'],[422,'ptz_flow_invalid']] as const) {
    wire.mockResolvedValueOnce(new Response(null,{status:statusCode}));
    await expect(client.measure(frames,check)).rejects.toMatchObject({code,statusCode});
  }
});
