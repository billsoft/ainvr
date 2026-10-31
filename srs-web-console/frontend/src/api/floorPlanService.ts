import { request, requestBlob } from './httpClient'
import { newAlarmOperationId } from './alarmZoneService'
import type { Plan, PlanDraft } from '@/pages/Analytics/plan/planModel'

type ImageRef = {ref:string;w:number;h:number}
type ServerPlan = Omit<Plan,'image'> & {image:ImageRef|null}
interface Entry {plan:ServerPlan;version:number;created_at:string;updated_at:string}
interface Saved extends Entry {saved:true}
export const floorPlanService = {
  list:()=>request<{items:Entry[]}>('/floor-plans'),
  save:(plan:Omit<Plan,'image'>&{image:ImageRef|Plan['image']},expected_version:number,key:string)=>
    request<Saved>('/floor-plans',{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({plan,expected_version})}),
  remove:(id:string,expected_version:number,key:string)=>request<{deleted:true;id:string}>(`/floor-plans/${encodeURIComponent(id)}/delete`,{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({expected_version})}),
  image:(ref:string)=>requestBlob(`/floor-plans/images/${encodeURIComponent(ref)}`),
}
async function validateImage(image:Plan['image']) {
  if(!image || !image.data.startsWith('data:'))return
  const decoded=await new Promise<HTMLImageElement>((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('底图无法解码，请重新选择图片'));img.src=image.data})
  if(decoded.naturalWidth!==image.w||decoded.naturalHeight!==image.h)throw new Error('底图尺寸与图像内容不一致')
}
/** Keeps versions and exact idempotent operations across retry, including partial multi-plan saves. */
export function createFloorPlanSession() {
  const versions=new Map<string,number>(), originals=new Map<string,string>(), refs=new Map<string,ImageRef>()
  const urls:string[]=[], pending=new Map<string,{body:string;key:string}>()
  const operation=(id:string,body:string)=>{const old=pending.get(id);if(old&&old.body!==body)throw new Error('上次保存结果未确认，请先重试原内容');if(old)return old.key;const key=newAlarmOperationId();pending.set(id,{body,key});return key}
  return {
    async load():Promise<PlanDraft> {
      if(pending.size) throw new Error('上次操作结果尚未确认，请先重试原内容')
      const {items}=await floorPlanService.list()
      const plans:Plan[]=[], nextVersions=new Map<string,number>(), nextOriginals=new Map<string,string>(), nextRefs=new Map<string,ImageRef>(), nextUrls:string[]=[]
      try {
        for(const entry of items){
          nextVersions.set(entry.plan.id,entry.version)
          let image:Plan['image']=null
          if(entry.plan.image){
            const blob=await floorPlanService.image(entry.plan.image.ref)
            if(!blob)throw new Error('平面图底图不可读取，请重试')
            const url=URL.createObjectURL(blob);nextUrls.push(url);nextRefs.set(url,entry.plan.image)
            image={data:url,w:entry.plan.image.w,h:entry.plan.image.h}
          }
          const plan={...entry.plan,image}
          plans.push(plan);nextOriginals.set(plan.id,JSON.stringify(plan))
        }
      } catch(e) { for(const url of nextUrls)URL.revokeObjectURL(url);throw e }
      versions.clear(); originals.clear(); refs.clear(); for(const url of urls) URL.revokeObjectURL(url); urls.length=0
      for(const [k,v] of nextVersions)versions.set(k,v)
      for(const [k,v] of nextOriginals)originals.set(k,v)
      for(const [k,v] of nextRefs)refs.set(k,v)
      urls.push(...nextUrls)
      return {version:2,plans,activeId:plans[0]?.id??null}
    },
    async save(draft:PlanDraft) {
      for(const plan of draft.plans){
        if(originals.get(plan.id)===JSON.stringify(plan))continue
        if(plan.image&&!refs.has(plan.image.data)) await validateImage(plan.image)
        const image=plan.image ? refs.get(plan.image.data)??plan.image : null
        const body={plan:{...plan,image},expected_version:versions.get(plan.id)??0}
        const key=operation(plan.id,JSON.stringify(body))
        let saved:Saved
        try { saved=await floorPlanService.save(body.plan,body.expected_version,key) } catch(e) { if([400,409,422].includes((e as {status?:number}).status??0))pending.delete(plan.id); throw e }
        if(!saved.saved || saved.plan.id!==plan.id || saved.version!==body.expected_version+1) throw new Error('平面图保存结果未确认')
        versions.set(plan.id,saved.version);originals.set(plan.id,JSON.stringify(plan));pending.delete(plan.id)
        if(plan.image && saved.plan.image) refs.set(plan.image.data,saved.plan.image)
      }
      for(const [id,version] of [...versions]){
        if(draft.plans.some(p=>p.id===id))continue
        const key=operation(id,JSON.stringify({delete:id,expected_version:version}))
        let result:{deleted:true;id:string}
        try { result=await floorPlanService.remove(id,version,key) } catch(e) { if([400,409,422].includes((e as {status?:number}).status??0))pending.delete(id); throw e }
        if(!result.deleted||result.id!==id)throw new Error('删除结果未确认')
        versions.delete(id);originals.delete(id);pending.delete(id)
      }
    },
    dispose(){for(const url of urls)URL.revokeObjectURL(url)},
  }
}
