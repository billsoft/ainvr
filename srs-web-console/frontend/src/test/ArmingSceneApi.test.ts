import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {request} from '@/api/httpClient'
import {armingSceneService} from '@/api/armingSceneService'
import {alarmArmingService} from '@/api/alarmArmingService'
vi.mock('@/api/httpClient',()=>({request:vi.fn()}))
beforeEach(()=>{vi.mocked(request).mockReset();localStorage.clear()})
afterEach(()=>vi.restoreAllMocks())
it('sends scene revisions and the trusted frozen frame in the atomic existing arming request',async()=>{
 const edits=[{zone_id:'z',expected_revision:4,mode:'edit' as const,frame_id:'frozen-epoch-frame'}]
 await alarmArmingService.save({sourceId:'source',geometryRevision:'g',expectedRevision:7,zones:[],assignments:[],counterBindings:[],
  removedZoneIds:[],removedAssignmentIds:[],removedCounterBindingIds:[],sceneEdits:edits},'op','processor')
 expect(request).toHaveBeenCalledWith('/alarms/arming/source',expect.objectContaining({method:'POST',headers:{'Idempotency-Key':'op'}}))
 expect(JSON.parse(String(vi.mocked(request).mock.calls[0]![1]!.body))).toMatchObject({expected_revision:7,
  arming:{processor_id:'processor',scene_edits:edits,source_id:'source',geometry_revision:'g'}})
})
it('reads and freezes in the input source plus processor scope without browser matcher results',async()=>{
 const timeout=vi.spyOn(AbortSignal,'timeout')
 await armingSceneService.read('source','processor')
 await armingSceneService.freeze('source','processor')
 expect(vi.mocked(request).mock.calls[0]![0]).toBe('/alarms/arming/source/scenes?processor_id=processor')
 expect(vi.mocked(request).mock.calls[1]![0]).toBe('/alarms/arming/source/scenes/frame')
 expect(JSON.parse(String(vi.mocked(request).mock.calls[1]![1]!.body))).toEqual({processor_id:'processor'})
 expect(timeout.mock.calls.map(c=>c[0])).toEqual([8000,45000])
})
it('fetches reference images with console authentication and refuses token forwarding off-origin',async()=>{
 localStorage.setItem('srs-console-token','test-token')
 const blob=new Blob(['jpeg'],{type:'image/jpeg'})
 const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue({ok:true,blob:async()=>blob} as Response)
 expect(await armingSceneService.image('/api/alarms/arming/source/scenes/frame/f/image')).toBe(blob)
 expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/api/alarms/arming/source/scenes/frame/f/image'),
  expect.objectContaining({headers:{'X-Console-Token':'test-token'},cache:'no-store'}))
 await expect(armingSceneService.image('https://other.invalid/api/image')).rejects.toThrow('不可信')
 expect(fetcher).toHaveBeenCalledTimes(1)
})
