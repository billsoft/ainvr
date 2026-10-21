import {expect,it,vi} from 'vitest'
import {createArmingSaveSession,type ArmingSaveRequest} from '@/features/armingSaveSession'
const change=(revision=1,name='区域')=>({sourceId:'source',geometryRevision:'g',expectedRevision:revision,zones:[{name}],assignments:[],removedZoneIds:[],removedAssignmentIds:[]})
const response=(version:number)=>({saved:true as const,sourceId:'source',revision:version,application:{state:'pending' as const}})
it('超时后同一内容沿用同一请求，不能把待应用误报为已应用',async()=>{
  const send=vi.fn().mockRejectedValueOnce(Error('timeout')).mockResolvedValueOnce(response(2))
  const session=createArmingSaveSession(send,()=> 'operation')
  await expect(session.save(change())).rejects.toThrow('timeout')
  const result=await session.save(change())
  expect(send.mock.calls[0]).toEqual(send.mock.calls[1])
  expect(result.application.state).toBe('pending')
  expect(send).toHaveBeenCalledTimes(2)
})
it('未确认旧请求期间禁止提交不同草稿，先明确解决原操作',async()=>{
  const send=vi.fn().mockRejectedValueOnce(Error('timeout')).mockResolvedValueOnce(response(2))
  const session=createArmingSaveSession(send,()=> 'operation')
  await expect(session.save(change())).rejects.toThrow()
  await expect(session.save(change(1,'别的修改'))).rejects.toThrow('先确认上次保存结果')
  expect(send).toHaveBeenCalledTimes(1)
  await session.retry()
  expect(session.hasPending()).toBe(false)
})
it('双击保存被拒绝，请求内容冻结不随外部草稿变化',async()=>{
  let resolve!:(value:ReturnType<typeof response>)=>void
  const send=vi.fn((_request:ArmingSaveRequest,_operationId:string)=>new Promise<ReturnType<typeof response>>(r=>{resolve=r}))
  const session=createArmingSaveSession(send,()=> 'operation'),draft=change()
  const first=session.save(draft)
  draft.zones[0]!.name='外部变化'
  await expect(session.save(draft)).rejects.toThrow('正在保存')
  expect(send.mock.calls[0]![0]).toMatchObject({zones:[{name:'区域'}]})
  resolve(response(2));await first
})
it('响应身份或版本不匹配时保留未确认请求',async()=>{
  const send=vi.fn().mockResolvedValue({...response(2),sourceId:'other'})
  const session=createArmingSaveSession(send,()=> 'operation')
  await expect(session.save(change())).rejects.toThrow('保存响应不匹配')
  expect(session.hasPending()).toBe(true)
})
it('明确版本冲突不自动覆盖，清理旧请求以便重新读取合并',async()=>{
  const send=vi.fn().mockRejectedValue(Object.assign(Error('conflict'),{status:409}))
  const session=createArmingSaveSession(send,()=> 'operation')
  await expect(session.save(change())).rejects.toThrow('conflict')
  expect(session.hasPending()).toBe(false)
})
