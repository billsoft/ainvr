import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const fake=vi.hoisted(()=>({run:vi.fn(),read:vi.fn(),remove:vi.fn(),time:100000,elapsed:2500,pts:'2.4'}));
vi.mock('node:child_process',()=>({execFile:Object.assign(()=>{},
 {[Symbol.for('nodejs.util.promisify.custom')]:fake.run})}));
vi.mock('node:fs/promises',()=>({access:vi.fn(async()=>{}),mkdtemp:vi.fn(async()=>'/dev/shm/controlled-scene'),
 readFile:fake.read,rm:fake.remove}));
import {captureScene} from '../services/sceneCapture.js';
const ctx={app:'live',stream:'controlled-no-camera',width:512,height:384};
// Minimal SOF fixture: validates metadata only. No decoder/model/image processing runs.
const jpeg=Buffer.from('ffd8ffc00011080180020003011100021100031100ffd9','hex');
beforeEach(()=>{
 vi.useFakeTimers();vi.setSystemTime(100000);fake.time=100000;fake.elapsed=2500;fake.pts='2.4';
 fake.run.mockReset();fake.read.mockReset();fake.remove.mockReset();
 fake.read.mockResolvedValue(jpeg);fake.remove.mockResolvedValue(undefined);
 fake.run.mockImplementation(async(file:string)=>{
  if(file.endsWith('/ffmpeg')){fake.time+=fake.elapsed;vi.setSystemTime(fake.time);return {stdout:'',stderr:''};}
  if(file.endsWith('/ffprobe'))return {stdout:JSON.stringify({streams:[{width:512,height:384}],packets:[{pos:'48',pts_time:'0'},{pos:'128',pts_time:fake.pts}]}),stderr:''};
  return {stdout:'',stderr:''};
 });
});
afterEach(()=>vi.useRealTimers());
it('rejects an immediate cached-GOP burst before decoding',async()=>{
 fake.elapsed=500;await expect(captureScene(ctx)).rejects.toThrow('scene_cached_video');
 expect(fake.run).toHaveBeenCalledTimes(1);expect(fake.remove).toHaveBeenCalledOnce();
});
it.each(['NaN','Infinity','-Infinity','bad',''])('rejects invalid packet presentation timestamp %s',async pts=>{
 fake.pts=pts;await expect(captureScene(ctx)).rejects.toThrow('scene_capture_incomplete');
 expect(fake.run).toHaveBeenCalledTimes(2);
});
it('documents that wall-clock remux duration cannot distinguish paced old GOP or frozen live pixels',async()=>{
 // All three sources can produce this identical transport transcript. The
 // source's actual exposure time is absent from captureScene's inputs.
 const observations=[];
 for(const provenance of ['live-static','paced-old-GOP','frozen-reencoded']){
  const frame=await captureScene(ctx);observations.push({provenance,frame});
 }
 expect(observations.map(o=>o.frame.at.getTime())).toEqual([102500,105000,107500]);
 expect(observations.every(o=>o.frame.bytes.equals(jpeg))).toBe(true);
 expect(observations.every(o=>o.frame.timing?.sourceFreshness==='unverified'&&o.frame.timing?.basis==='receiver-wallclock')).toBe(true);
 // Equality is not a freshness oracle: a legitimate static camera can produce
 // identical JPEGs too. This test records the unresolved source-protocol limit.
 expect(fake.run.mock.calls.filter(c=>String(c[0]).endsWith('/ffmpeg')).every(c=>c[1].includes('-use_wallclock_as_timestamps'))).toBe(true);
});
