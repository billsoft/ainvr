import {z} from 'zod';

const pose=z.object({schema_version:z.literal('1.0'),type:z.literal('keypoints'),layout:z.literal('coco17'),count:z.literal(17),coordinate_space:z.literal('original_image'),point_fields:z.tuple([z.literal('x'),z.literal('y'),z.literal('score')])});
const catalog=z.object({adapter:z.string(),attributes:z.object({pose:pose.optional()}).optional(),labels:z.array(z.object({label_id:z.string(),name:z.string(),source_node:z.string().optional(),source_adapter:z.string().optional()}))});
export interface RegionCapability {event_kind:string;ready:boolean;label_ids:string[]}
// Called only after source identity, freshness and applied configuration checks.
// A catalog describes loaded labels/schema; per-frame attestation remains the
// engine's authority for whether a particular observation is valid.
export function alarmRegionCapabilities(raw:unknown,config:{model:{adapter:string};analytics?:{enabled:boolean};analysis_pipeline?:unknown}):RegionCapability[]{
 const extra=z.object({label_catalog:catalog,analytics:z.object({status:z.enum(['active','detection_only'])}),analysis_pipeline:z.object({complete:z.literal(true),nodes:z.array(z.object({node_id:z.string(),status:z.literal('complete')}))}).optional()}).safeParse(raw);
 if(!extra.success||config.analytics?.enabled!==true)return [];
 const cat=extra.data.label_catalog;
 const graph=z.object({root_id:z.string().default('primary'),nodes:z.array(z.object({id:z.string(),model:z.object({adapter:z.string()})}))}).safeParse(config.analysis_pipeline);
 const owners=new Map<string,string>();
 if(cat.adapter==='analysis_pipeline'){
  if(!graph.success||!extra.data.analysis_pipeline)return [];
  owners.set(graph.data.root_id,config.model.adapter);
  for(const node of graph.data.nodes)owners.set(node.id,node.model.adapter);
  const completed=extra.data.analysis_pipeline.nodes;
  if(completed.length!==owners.size||[...owners.keys()].some(id=>!completed.some(n=>n.node_id===id)))return [];
 }
 const groups=new Map<string,string[]>();
 const add=(kind:string,id:string)=>groups.set(kind,[...(groups.get(kind)??[]),id]);
 for(const label of cat.labels){
  const adapter=cat.adapter==='analysis_pipeline'?owners.get(label.source_node??''):cat.adapter;
  if(!adapter||(cat.adapter==='analysis_pipeline'&&adapter!==label.source_adapter))continue;
  if(adapter==='yolo26_bpu'){
   if(['fire','smoke'].includes(label.name))add('fire_smoke',label.label_id);
   if(label.name==='no_helmet')add('helmet_violation',label.label_id);
  }
  if(cat.attributes?.pose&&label.name==='person'&&['yolo26_bpu','yolo26_pose_bpu'].includes(adapter)
    &&(cat.adapter==='yolo26_pose_bpu'||[...owners.values()].includes('yolo26_pose_bpu')))add('suspected_down',label.label_id);
 }
 return [...groups].map(([event_kind,label_ids])=>({event_kind,ready:true,label_ids}));
}
