import {it,expect} from 'vitest';
import {buildAlarmSourceCatalog} from '../services/alarmSourceCatalog.js';
import type {Channel} from '../types/channel.js';
const now=Date.parse('2026-10-19T12:00:00Z');
const input:Channel={id:'input',name:'大门',streamName:'xm',upstreamProtocol:'rtmp',downstreamProtocols:['flv'],createdAt:now,updatedAt:now};
const channel={id:'processor',name:'AI 大门',state:'running',config:{model:{name:'yoloe',adapter:'yoloe_bpu',prompts:[{description:'person',label_id:'p',label_name:'行人'}]},stream:{url:'rtmp://127.0.0.1:1935/live/xm'},inference_fps:1,analytics:{enabled:true}}};
const frame={channel_id:'processor',stream_url:channel.config.stream.url,timestamp:now/1000,frame_width:3840,frame_height:2160,model:{name:'yoloe'},model_extra:{label_catalog:{schema_version:'1.0',adapter:'yoloe_bpu',labels:[{class_id:0,label_id:'p',name:'行人',description:'person'}]},analytics:{status:'active',stream_session_id:'s'}}};
it('binds separate processor and input identities and matches preview geometry version',()=>{
 const c=buildAlarmSourceCatalog(channel,frame,[input],now)!;
 expect(c.channel_id).toBe('processor');expect(c.input_stream_id).toBe('input');expect(c.tracking_available).toBe(true);
 expect(c.geometry_revision).toBe('source-frame-v2:input:2026-10-19T12:00:00.000Z:3840x2160');
 expect(c.label_ids).toEqual(['p']);expect(c.label_map_version).toMatch(/^labels-[a-f0-9]{64}$/);
 expect(JSON.stringify(c)).not.toContain('rtmp://');
});
it('rejects stale results, ambiguous input, and model configuration changed ahead of results',()=>{
 expect(buildAlarmSourceCatalog(channel,frame,[input],now+61000)).toBeNull();
 expect(buildAlarmSourceCatalog(channel,frame,[input,{...input,id:'duplicate'}],now)).toBeNull();
 const changed=structuredClone(channel);changed.config.model.prompts[0]!.description='car';
 expect(buildAlarmSourceCatalog(changed,frame,[input],now)).toBeNull();
 expect(buildAlarmSourceCatalog(channel,{...frame,stream_url:'rtmp://127.0.0.1/live/other'},[input],now)).toBeNull();
 expect(buildAlarmSourceCatalog(channel,{...frame,model_extra:{}},[input],now)).toBeNull();
});
it('fixed catalogs include unobserved labels and disabled tracking is explicit',()=>{
 const fixed={...channel,config:{...channel.config,analytics:{enabled:false},model:{name:'coco',adapter:'yolo26_bpu',class_names:null}}};
 const f={...frame,model:{name:'coco'},model_extra:{label_catalog:{schema_version:'1.0',adapter:'yolo26_bpu',labels:[{class_id:0,label_id:'class:0',name:'person',description:''},{class_id:1,label_id:'class:1',name:'car',description:''}]}}};
 const c=buildAlarmSourceCatalog(fixed,f,[input],now)!;expect(c.label_ids).toHaveLength(2);expect(c.tracking_available).toBe(false);
});

it('display-name/remark changes preserve zones; input identity or resolution changes invalidate them',()=>{
 const initial=buildAlarmSourceCatalog(channel,frame,[input],now)!;
 const rename=buildAlarmSourceCatalog(channel,frame,[{...input,name:'renamed',remark:'new note',updatedAt:now+1000}],now)!;
 expect(rename.geometry_revision).toBe(initial.geometry_revision);
 for(const changed of [{...input,inputGeneration:'new-source'},{...input,id:'replacement'}])
  expect(buildAlarmSourceCatalog(channel,frame,[changed],now)!.geometry_revision).not.toBe(initial.geometry_revision);
 expect(buildAlarmSourceCatalog(channel,{...frame,frame_width:1920},[input],now)!.geometry_revision).not.toBe(initial.geometry_revision);
});
