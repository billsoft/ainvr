import {beforeEach,expect,it,vi} from 'vitest'
import { createFloorPlanSession, floorPlanService } from '@/api/floorPlanService'
vi.mock('@/api/httpClient',()=>({request:vi.fn(),requestBlob:vi.fn()}))
const plan={id:'p1',name:'入口',shapes:[],placements:{},image:{ref:'image-1',w:100,h:80}}
const entry={plan,version:2,created_at:'2026-01-01',updated_at:'2026-01-01'}
beforeEach(()=>{vi.restoreAllMocks();vi.stubGlobal('URL',{...URL,createObjectURL:vi.fn(()=> 'blob:floor'),revokeObjectURL:vi.fn()})})
it('loads authenticated images and saves unchanged references with optimistic version',async()=>{
 vi.spyOn(floorPlanService,'list').mockResolvedValue({items:[entry]})
 vi.spyOn(floorPlanService,'image').mockResolvedValue(new Blob(['image']))
 const save=vi.spyOn(floorPlanService,'save').mockResolvedValue({...entry,version:3,saved:true})
 const session=createFloorPlanSession(),draft=await session.load()
 expect(floorPlanService.image).toHaveBeenCalledWith('image-1')
 draft.plans[0]!.name='新名称'
 await session.save(draft)
 expect(save).toHaveBeenCalledWith({...plan,name:'新名称'},2,expect.any(String))
 session.dispose();expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:floor')
})
it('retries an uncertain save with the same operation key and refuses modified replay',async()=>{
 vi.spyOn(floorPlanService,'list').mockResolvedValue({items:[]})
 const save=vi.spyOn(floorPlanService,'save').mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({plan:{...plan,image:null},version:1,created_at:'',updated_at:'',saved:true})
 const session=createFloorPlanSession(),draft=await session.load();draft.plans.push({...plan,image:null})
 await expect(session.save(draft)).rejects.toThrow('timeout')
 draft.plans[0]!.name='changed'
 await expect(session.save(draft)).rejects.toThrow('未确认')
 draft.plans[0]!.name='入口'
 await session.save(draft)
 expect(save.mock.calls[0]![2]).toBe(save.mock.calls[1]![2])
})

it('allows a definitive conflict to reload fresh server versions without stale plans',async()=>{
 const list=vi.spyOn(floorPlanService,'list').mockResolvedValueOnce({items:[{...entry,plan:{...plan,image:null}}]}).mockResolvedValueOnce({items:[]})
 const save=vi.spyOn(floorPlanService,'save').mockRejectedValue(Object.assign(new Error('conflict'),{status:409}))
 const remove=vi.spyOn(floorPlanService,'remove')
 const session=createFloorPlanSession(),draft=await session.load();draft.plans[0]!.name='changed'
 await expect(session.save(draft)).rejects.toThrow('conflict')
 const fresh=await session.load()
 expect(fresh.plans).toEqual([])
 await session.save(fresh)
 expect(remove).not.toHaveBeenCalled()
 expect(list).toHaveBeenCalledTimes(2);expect(save).toHaveBeenCalledTimes(1)
})
