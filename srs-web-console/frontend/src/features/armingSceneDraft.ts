import type {ArmingScene,ArmingSceneEdit,ArmingSceneFrame} from '@/api/armingSceneService'
import type {ArmingDocument,ArmingZoneDocument} from './armingDocument'
import type {ArmingSaveRequest} from './armingSaveSession'
import type {ZonePoint} from './alarmGeometry'

export interface SceneEditingContext {
 processorId:string;frame:ArmingSceneFrame
}
export type SceneIntents=Record<string,'bind'|'edit'|'unbind'>
/** Unknown or malformed geometry must never reveal the canonical reference. */
export function validScenePoints(points:unknown,vertices:number):points is ZonePoint[] {
 return Array.isArray(points)&&points.length===vertices&&vertices>=3&&points.every(p=>
  Array.isArray(p)&&p.length===2&&p.every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1))
}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)
export function sceneFor(context:SceneEditingContext|undefined,zone:string):ArmingScene|undefined {
 return context?.frame.items.find(s=>s.zone_id===zone&&s.processor_id===context.processorId)
}
export function sceneViewPoints(context:SceneEditingContext|undefined,zone:string):ZonePoint[]|null|undefined {
 const scene=sceneFor(context,zone)
 return scene?(scene.state==='matched'&&validScenePoints(scene.current_points,scene.reference_points.length)?scene.current_points:null):undefined
}
/** Project only for this frozen editor view. Keep the canonical base untouched. */
export function sceneEditorDocument(base:ArmingDocument|null,context?:SceneEditingContext):ArmingDocument|null {
 if(!base||!context)return base
 const visible=structuredClone(base)
 for(const zone of visible.zones){const points=sceneViewPoints(context,zone.zone_id);if(points)zone.points=structuredClone(points)}
 return visible
}
/** A runtime projection is never a manual edit. Restore canonical geometry for
 * untouched bindings; explicit manual changes carry the frozen frame's CAS. */
export function withSceneEdits(request:ArmingSaveRequest,base:ArmingDocument|null,
 context:SceneEditingContext|undefined,intents:SceneIntents):ArmingSaveRequest {
 if(!context)return request
 const result=structuredClone(request),edits:ArmingSceneEdit[]=[]
 for(const value of result.zones){
  const zone=value as ArmingZoneDocument,old=base?.zones.find(z=>z.zone_id===zone.zone_id)
  const scene=sceneFor(context,zone.zone_id),projection=sceneViewPoints(context,zone.zone_id)
  let mode=intents[zone.zone_id]
  if(scene&&!mode&&old){
   if(projection===null&&(!same(zone.points,old.points)||!same(zone.edge_ids,old.edge_ids)))
    throw Error('场景尚未匹配，请明确重新绘制并绑定当前画面；草稿已保留。')
   if(projection&&(!same(zone.points,projection)||!same(zone.edge_ids,old.edge_ids)||!!zone.erp_wrap!==!!old.erp_wrap))mode='edit'
   else {
    zone.points=structuredClone(old.points);zone.edge_ids=[...old.edge_ids]
    zone.version=old.version+(zone.name!==old.name?1:0)
   }
  }
  if(mode){
   if(!old&&!(mode==='bind'&&context.frame.binding_mode==='preset'))throw Error('请先保存新热区，再启用场景绑定。')
   if(!context.frame.frame_id||!context.frame.identity||!context.frame.epoch)throw Error('冻结参考不可用，请保留草稿并重新核对。')
   if(mode==='unbind'&&scene&&projection===null)throw Error('当前场景未匹配，不能将旧区域解除为当前画面区域；请先重新绘制。')
   edits.push({zone_id:zone.zone_id,expected_revision:scene?.revision??0,mode,frame_id:context.frame.frame_id,
    ...(context.frame.binding_mode==='preset'?{binding_mode:'preset' as const}:{})})
  }
 }
 // Keep assignment versions coherent with canonical zones restored above.
 for(const values of [result.assignments,result.counterBindings])for(const value of values){
  const row=value as {zone_id:string|null;zone_version:number|null}
  if(row.zone_id)row.zone_version=(result.zones as ArmingZoneDocument[]).find(z=>z.zone_id===row.zone_id)?.version??null
 }
 return {...result,...(edits.length?{sceneEdits:edits}:{})}
}
