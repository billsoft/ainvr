import {it,expect,vi,afterEach} from 'vitest';
import {readArmingGeometry} from '../services/alarmArmingGeometry.js';
import {readAlarmSourceCatalog} from '../services/alarmSourceCatalog.js';
vi.mock('../services/alarmSourceCatalog.js',()=>({readAlarmSourceCatalog:vi.fn()}));
vi.mock('../routes/aiProxy.js',()=>({resolveAiApiKey:vi.fn(async()=>null)}));
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
const settings={aiService:{baseUrl:'http://127.0.0.1:8090'}} as never;
const inputs=[{id:'camera',app:'live',streamName:'gate'}] as never;
it('来源几何只能由最新服务目录确认，多个处理器冲突拒绝保存',async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({channels:[
  {id:'a',config:{stream:{url:'rtmp://127.0.0.1/live/gate'}}},
  {id:'b',config:{stream:{url:'rtmp://127.0.0.1/live/gate'}}},
  {id:'unrelated',config:{stream:{url:'rtmp://127.0.0.1/live/other'}}},
 ]}),{headers:{'content-type':'application/json'}}));
 vi.stubGlobal('fetch',fetcher);
 vi.mocked(readAlarmSourceCatalog).mockImplementation(async id=>({input_stream_id:'camera',geometry_revision:id==='a'?'g1':'g2'}) as never);
 expect(await readArmingGeometry('camera',settings,inputs,'',null)).toBeNull();
 expect(readAlarmSourceCatalog).toHaveBeenCalledTimes(2);
 vi.mocked(readAlarmSourceCatalog).mockResolvedValue({input_stream_id:'camera',geometry_revision:'g1'} as never);
 expect(await readArmingGeometry('camera',settings,inputs,'',null)).toBe('g1');
});
it('未知来源不访问设备，离线时不猜测尺寸',async()=>{
 const fetcher=vi.fn(async()=>{throw Error('offline')});vi.stubGlobal('fetch',fetcher);
 expect(await readArmingGeometry('missing',settings,inputs,'',null)).toBeNull();
 expect(fetcher).not.toHaveBeenCalled();
 expect(await readArmingGeometry('camera',settings,inputs,'',null)).toBeNull();
});

it('原始在线流尺寸允许没有AI结果时绘区，不访问推理服务',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 const streams=async()=>[{app:'live',name:'gate',publish:{active:true},clients:0,video:{width:3840,height:2160}}];
 const channels=[{id:'camera',app:'live',streamName:'gate',inputGeneration:'generation',createdAt:0}] as never;
 expect(await readArmingGeometry('camera',settings,channels,'',null,streams)).toBe('source-frame-v2:camera:generation:3840x2160');
 expect(fetcher).not.toHaveBeenCalled();
});
it('原始流离线、歧义或尺寸无效时，不用陈旧AI结果补猜',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 const c=[{id:'camera',app:'live',streamName:'gate',createdAt:0}] as never;
 const valid={app:'live',name:'gate',publish:{active:true},clients:0,video:{width:1920,height:1080}};
 for(const items of [[],[{...valid,publish:{active:false}}],[valid,valid],[{...valid,video:{width:0,height:1080}}]])
  expect(await readArmingGeometry('camera',settings,c,'',null,async()=>items)).toBeNull();
 expect(fetcher).not.toHaveBeenCalled();
});
it('原始流来源代次与前端一致，改名不影响，替换输入才改变',async()=>{
 const c={id:'camera',app:'live',streamName:'gate',createdAt:0};
 const streams=async()=>[{app:'live',name:'gate',publish:{active:true},clients:0,video:{width:1920,height:1080}}];
 const first=await readArmingGeometry('camera',settings,[c] as never,'',null,streams);
 expect(first).toBe('source-frame-v2:camera:1970-01-01T00:00:00.000Z:1920x1080');
 expect(await readArmingGeometry('camera',settings,[{...c,name:'改名',updatedAt:123}] as never,'',null,streams)).toBe(first);
 expect(await readArmingGeometry('camera',settings,[{...c,inputGeneration:'replacement'}] as never,'',null,streams)).not.toBe(first);
});
