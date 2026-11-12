import {it,expect} from 'vitest';
import {buildAlarmSourceCatalog} from '../services/alarmSourceCatalog.js';
import type {Channel} from '../types/channel.js';
const now=Date.parse('2026-10-19T12:00:00Z');
const input:Channel={id:'input',name:'大门',streamName:'xm',upstreamProtocol:'rtmp',downstreamProtocols:['flv'],createdAt:now,updatedAt:now};
const channel={id:'processor',name:'AI 大门',state:'running',config:{model:{name:'yoloe',adapter:'yoloe_bpu',prompts:[{description:'person',label_id:'p',label_name:'行人'}]},stream:{url:'rtmp://127.0.0.1:1935/live/xm'},inference_fps:5,analytics:{enabled:true}}};
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

it('low rate and runtime detection-only cannot offer tracking; zero FPS means follow source',()=>{
 const low={...channel,config:{...channel.config,inference_fps:1.99}};
 expect(buildAlarmSourceCatalog(low,frame,[input],now)!.tracking_available).toBe(false);
 expect(buildAlarmSourceCatalog({...channel,config:{...channel.config,inference_fps:0}},frame,[input],now)!.tracking_available).toBe(true);
 const slowFrame={...frame,model_extra:{...frame.model_extra,analytics:{status:'detection_only',stream_session_id:'s'}}};
 const source=buildAlarmSourceCatalog(channel,slowFrame,[input],now)!;
 expect(source.tracking_available).toBe(false);expect(source.detection_available).toBe(true);
});

it('2 FPS with active runtime supports alarm tracking',()=>{
 expect(buildAlarmSourceCatalog({...channel,config:{...channel.config,inference_fps:2}},frame,[input],now)!.tracking_available).toBe(true);
});
it('names why a source is not usable',()=>{
 const reasons:string[]=[],why=(r:string)=>reasons.push(r);
 buildAlarmSourceCatalog(channel,frame,[input],now+61000,why);
 buildAlarmSourceCatalog(channel,frame,[input,{...input,id:'duplicate'}],now,why);
 buildAlarmSourceCatalog({...channel,state:'reconnecting'},frame,[input],now,why);
 buildAlarmSourceCatalog(channel,{...frame,stream_url:'rtmp://127.0.0.1/live/other'},[input],now,why);
 expect(reasons).toEqual(['latest_result_stale:61s','input_channel_matches:2','channel_not_running:reconnecting','result_from_other_configuration']);
 expect(buildAlarmSourceCatalog(channel,frame,[input],now,why)).not.toBeNull();
 expect(reasons).toHaveLength(4);
});

it('multi-model catalogue binds actual graph and retains source-specific labels',()=>{
 const graph={execution:'parallel',nodes:[{id:'face',model:{adapter:'yoloface_bpu',name:'face'}}]};
 const c={...channel,config:{...channel.config,analysis_pipeline:graph}};
 const f={...frame,model_extra:{...frame.model_extra,analysis_pipeline:{configuration:graph},label_catalog:{schema_version:'1.0',adapter:'analysis_pipeline',labels:[{...frame.model_extra.label_catalog.labels[0],source_node:'primary'},{class_id:1,label_id:'node:face:class:0',name:'face',description:'',source_node:'face'}]}}};
 expect(buildAlarmSourceCatalog(c,f,[input],now)?.label_ids).toEqual(['p','node:face:class:0']);
 expect(buildAlarmSourceCatalog({...c,config:{...c.config,analysis_pipeline:{...graph,execution:'serial'}}},f,[input],now)).toBeNull();
 const changed=structuredClone(f);changed.model_extra.label_catalog.labels[0].description='different';expect(buildAlarmSourceCatalog(c,changed,[input],now)).toBeNull();
});
it('remaining model keeps rule source support after the imported model is removed',()=>{
 const graph={execution:'serial',root_id:'face',order:['face'],nodes:[]};
 const c={...channel,config:{...channel.config,model:{name:'face',adapter:'yoloface_bpu'},analysis_pipeline:graph}};
 const f={...frame,model:{name:'face'},model_extra:{...frame.model_extra,analysis_pipeline:{configuration:graph},label_catalog:{schema_version:'1.0',adapter:'analysis_pipeline',labels:[{class_id:0,label_id:'node:face:class:0',name:'face',description:'',source_node:'face'}]}}};
 expect(buildAlarmSourceCatalog(c,f,[input],now)?.label_ids).toEqual(['node:face:class:0']);
 expect(buildAlarmSourceCatalog(c,{...f,model_extra:{...f.model_extra,analysis_pipeline:{configuration:{...graph,order:['primary']}}}},[input],now)).toBeNull();
});
