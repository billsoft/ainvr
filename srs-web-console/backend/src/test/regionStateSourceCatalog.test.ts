import {it,expect} from 'vitest';
import {buildAlarmSourceCatalog} from '../services/alarmSourceCatalog.js';
import type {Channel} from '../types/channel.js';
const now=Date.now();
const input={id:'input',name:'camera',streamName:'camera',createdAt:now} as Channel;
const pose={schema_version:'1.0',type:'keypoints',layout:'coco17',count:17,coordinate_space:'original_image',point_fields:['x','y','score']};
function source(adapter='yolo26_bpu',names=['fire','smoke','no_helmet','head']){
 const channel={id:'ai',state:'running',config:{model:{name:'loaded',adapter},stream:{url:'rtmp://127.0.0.1/live/camera'},inference_fps:5,analytics:{enabled:true}}};
 const frame:any={channel_id:'ai',stream_url:channel.config.stream.url,timestamp:now/1000,frame_width:1000,frame_height:1000,model:{name:'loaded'},model_extra:{label_catalog:{schema_version:'1.0',adapter,labels:names.map((name,class_id)=>({class_id,label_id:`class:${class_id}`,name,description:''}))},analytics:{status:'detection_only',stream_session_id:'s'}}};
 return {channel,frame};
}
it('source endpoint catalog returns only native supported labels, including detection-only',()=>{
 const {channel,frame}=source();
 expect(buildAlarmSourceCatalog(channel,frame,[input],now)?.region_capabilities).toEqual([{event_kind:'fire_smoke',ready:true,label_ids:['class:0','class:1']},{event_kind:'helmet_violation',ready:true,label_ids:['class:2']}]);
 frame.model_extra.analytics.status='skipped';expect(buildAlarmSourceCatalog(channel,frame,[input],now)?.region_capabilities).toEqual([]);
});
it('helmet-head cannot enable PPE candidates: head is not no_helmet',()=>{
 const {channel,frame}=source('yolo26_bpu',['helmet','head']);
 channel.config.model.name='helmet-head';frame.model.name='helmet-head';
 expect(buildAlarmSourceCatalog(channel,frame,[input],now)?.region_capabilities).toEqual([]);
 const explicit=source('yolo26_bpu',['helmet','no_helmet']);
 expect(buildAlarmSourceCatalog(explicit.channel,explicit.frame,[input],now)?.region_capabilities).toEqual([{event_kind:'helmet_violation',ready:true,label_ids:['class:1']}]);
});
it('prompt names, disabled analytics, and stale frames never claim ready',()=>{
 const {channel,frame}=source('yoloe_bpu');
 channel.config.model.adapter='unknown_adapter';frame.model_extra.label_catalog.adapter='unknown_adapter';
 expect(buildAlarmSourceCatalog(channel,frame,[input],now)?.region_capabilities).toEqual([]);
 const native=source();native.channel.config.analytics.enabled=false;
 expect(buildAlarmSourceCatalog(native.channel,native.frame,[input],now)?.region_capabilities).toEqual([]);
 expect(buildAlarmSourceCatalog(native.channel,native.frame,[input],now+61000)).toBeNull();
});
it('suspected down requires the loaded strict coco17 schema and adapter',()=>{
 const {channel,frame}=source('yolo26_pose_bpu',['person']);
 expect(buildAlarmSourceCatalog(channel,frame,[input],now)?.region_capabilities).toEqual([]);
 frame.model_extra.label_catalog.attributes={pose};
 expect(buildAlarmSourceCatalog(channel,frame,[input],now)?.region_capabilities).toEqual([{event_kind:'suspected_down',ready:true,label_ids:['class:0']}]);
 frame.model_extra.label_catalog.attributes.pose={...pose,count:5};
 expect(buildAlarmSourceCatalog(channel,frame,[input],now)?.region_capabilities).toEqual([]);
});
it('pipeline readiness requires every configured node complete and correct label owner',()=>{
 const {channel,frame}=source();const graph={nodes:[{id:'pose',model:{adapter:'yolo26_pose_bpu'}}]};
 const c={...channel,config:{...channel.config,analysis_pipeline:graph}};
 frame.model_extra.label_catalog.adapter='analysis_pipeline';
 frame.model_extra.label_catalog.labels.forEach((l:any)=>Object.assign(l,{source_node:'primary',source_adapter:'yolo26_bpu'}));
 frame.model_extra.analysis_pipeline={configuration:graph,complete:false,nodes:[{node_id:'primary',status:'complete'}]};
 expect(buildAlarmSourceCatalog(c,frame,[input],now)?.region_capabilities).toEqual([]);
 frame.model_extra.analysis_pipeline.complete=true;
 expect(buildAlarmSourceCatalog(c,frame,[input],now)?.region_capabilities).toEqual([]);
 frame.model_extra.analysis_pipeline.nodes.push({node_id:'pose',status:'complete'});
 expect(buildAlarmSourceCatalog(c,frame,[input],now)?.region_capabilities).toHaveLength(2);
 frame.model_extra.label_catalog.labels.forEach((l:any)=>l.source_adapter='yoloe_bpu');
 expect(buildAlarmSourceCatalog(c,frame,[input],now)?.region_capabilities).toEqual([]);
});
