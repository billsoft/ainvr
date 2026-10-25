import {it,expect} from 'vitest';
import {ChannelService,type ChannelServiceOptions} from '../services/channelService.js';

it('managed GB input preserves publishing identity but still permits naming and disabling',async()=>{
 const data={channels:[{id:'fixture',name:'camera',upstreamProtocol:'rtmp',app:'live',streamName:'gb_fixture',downstreamProtocols:['flv'],createdAt:1,updatedAt:1}]};
 const service=new ChannelService({
  store:{read:async()=>structuredClone(data),mutate:async(fn:(value:typeof data)=>void)=>{fn(data);return structuredClone(data)}},
  settingsStore:{read:async()=>({})},srsClient:{listStreams:async()=>[],isOnline:async()=>false},
  protectedIdentity:async()=>true,
 } as unknown as ChannelServiceOptions);
 for(const change of [{streamName:'wrong'},{app:'other'},{upstreamProtocol:'rtsp' as const}])
  await expect(service.updateChannel('fixture',change)).rejects.toMatchObject({code:'CONFLICT'});
 expect(data.channels[0].streamName).toBe('gb_fixture');
 expect((await service.updateChannel('fixture',{name:'renamed',inputEnabled:false})).name).toBe('renamed');
 expect((data.channels[0] as {inputEnabled?:boolean}).inputEnabled).toBe(false);
});
