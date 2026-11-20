import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { usePtzControl } from '@/components/player/usePtzControl';
const m=vi.hoisted(()=>({read:vi.fn(),save:vi.fn(),acquire:vi.fn(),command:vi.fn(),stop:vi.fn(),probe:vi.fn(),measure:vi.fn(),capture:vi.fn()}));
vi.mock('@/api/ptzService',()=>({ptzService:{visualCalibration:m.read,saveVisualCalibration:m.save,
  measureFlow:m.measure,acquire:m.acquire,command:m.command,stop:m.stop},ptzError:(e:Error)=>e.message}));
vi.mock('@/store/toast',()=>({toast:{error:vi.fn()}}));
vi.mock(import('@/components/player/ptzFlowFrames'), async original => ({
  ...await original(), captureFlowView: m.capture,
}));
vi.mock('@/components/player/ptzFlowCenter',()=>({
  runFlowCalibrationProbe:m.probe,
  flowCalibrationCoverage:(snapshot:any)=>(['pan','tilt']).flatMap(axis=>[-1,1].map(sign=>({axis,sign,
    ready:(snapshot?.records??[]).filter((r:any)=>r.axis===axis&&r.sign===sign).length>=6}))),
}));
const video={videoWidth:1920,videoHeight:1080} as HTMLVideoElement;
beforeEach(()=>{
  vi.resetAllMocks();
  m.read.mockResolvedValue({scope:'scope',estimator:'neuflow-v1',epoch:2,revision:0,snapshot:null,zoomEvidence:'unknown'});
  m.save.mockImplementation(async()=>({revision:m.save.mock.calls.length}));
  m.acquire.mockResolvedValue({sessionId:'lease',leaseMs:1200});
  m.stop.mockResolvedValue({stopConfirmed:true});m.command.mockResolvedValue({});
  m.capture.mockResolvedValue({initial:{jpeg:'frame0'},fresh:async()=>({jpeg:'frame1'})});
  m.probe.mockImplementation(async(_frames,axis,sign,signal,control)=>{
    signal.throwIfAborted();await control.measure(_frames.initial, await _frames.fresh(signal), signal);await control.prepare();
    await control.move({pan:axis==='pan'?sign*.36:0,tilt:axis==='tilt'?sign*.36:0,zoom:0});
    await control.release();
    const old=control.calibrationStore.load();
    control.calibrationStore.save({version:1,records:[...old.records,{axis,sign}]});return true;
  });
});
it('calibrates all four directions, commits every sample, then stops without zoom',async()=>{
  const {result,unmount}=renderHook(()=>usePtzControl('camera','identity',()=>{}));
  await act(async()=>{await result.current.calibrate(video);});
  expect(m.probe).toHaveBeenCalledTimes(24);expect(m.save).toHaveBeenCalledTimes(24);
  expect(m.stop).toHaveBeenCalledTimes(24);
  expect(new Set(m.probe.mock.calls.map(call=>call[4].calibrationWarmup)).size).toBe(1);
  expect(m.probe.mock.calls[0]![4].calibrationWarmup).toEqual({ready:false});
  expect(m.measure).toHaveBeenCalledTimes(24);
  expect(m.measure).toHaveBeenCalledWith('camera','identity',2,'frame0','frame1',expect.any(AbortSignal));
  expect(m.save.mock.calls.every(c=>c.at(-1)==='neuflow-v1')).toBe(true);
  expect(m.command.mock.calls.every(c=>c[3].zoom===0)).toBe(true);
  expect(result.current.calibration).toMatchObject({running:false,ready:4});
  expect(result.current.calibration.message).toContain('完成');unmount();
});
it('stop during a pending save prevents all later movement and preserves measured data',async()=>{
  let resolve!:(value:any)=>void;
  m.save.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
  const {result,unmount}=renderHook(()=>usePtzControl('camera','identity',()=>{}));
  let run!:Promise<void>;
  act(()=>{run=result.current.calibrate(video);});
  await waitFor(()=>expect(m.save).toHaveBeenCalledTimes(1));
  await act(async()=>{await result.current.stop();resolve({revision:1});await run;});
  expect(m.command).toHaveBeenCalledTimes(1);expect(m.save).toHaveBeenCalledTimes(1);
  expect(result.current.calibration).toMatchObject({running:false});
  expect(result.current.calibration.message).toContain('已停止');unmount();
});
it('never moves another direction after Stop fails',async()=>{
  m.stop.mockRejectedValue(Error('ptz_stop_unconfirmed'));
  const {result,unmount}=renderHook(()=>usePtzControl('camera','identity',()=>{}));
  await act(async()=>{await result.current.calibrate(video);});
  expect(m.command).toHaveBeenCalledTimes(1);expect(m.save).not.toHaveBeenCalled();
  expect(result.current.error).toBe('ptz_stop_unconfirmed');unmount();
});
it('ends the sequence on a command acknowledgement failure',async()=>{
  m.probe.mockImplementationOnce(async(_f,_a,_s,_signal,control)=>{
    await control.prepare();await control.move({pan:.36,tilt:0,zoom:0});await control.release();
    throw Error('运动回执未及时确认，已确认停转并结束定位。');
  });
  const {result,unmount}=renderHook(()=>usePtzControl('camera','identity',()=>{}));
  await act(async()=>{await result.current.calibrate(video);});
  expect(m.acquire).toHaveBeenCalledTimes(1);expect(m.command).toHaveBeenCalledTimes(1);
  expect(m.save).not.toHaveBeenCalled();expect(result.current.calibration.running).toBe(false);unmount();
});
it('an old cancelled save cannot clear the running state of a newer calibration',async()=>{
  let oldSave!:(value:any)=>void, newRead!:(value:any)=>void;
  m.save.mockImplementationOnce(()=>new Promise(r=>{oldSave=r;}));
  const {result,unmount}=renderHook(()=>usePtzControl('camera','identity',()=>{}));
  let first!:Promise<void>,second!:Promise<void>;
  act(()=>{first=result.current.calibrate(video);});
  await waitFor(()=>expect(m.save).toHaveBeenCalledTimes(1));
  await act(async()=>{await result.current.stop();});
  m.read.mockImplementationOnce(()=>new Promise(r=>{newRead=r;}));
  act(()=>{second=result.current.calibrate(video);});
  await act(async()=>{oldSave({revision:1});await first;});
  expect(result.current.calibration.running).toBe(true);
  await act(async()=>{await result.current.stop();newRead({scope:'scope',epoch:2,revision:1});await second;});
  expect(result.current.calibration.running).toBe(false);unmount();
});
