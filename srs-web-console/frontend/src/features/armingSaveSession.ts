export interface ArmingSaveRequest {
  coordinateSpace?:'planar'|'erp'
  sourceId:string
  geometryRevision:string
  expectedRevision:number
  zones:unknown[]
  assignments:unknown[]
  removedZoneIds:string[]
  removedAssignmentIds:string[]
  counterBindings:unknown[]
  removedCounterBindingIds:string[]
}
export interface ArmingSaveResult {
  saved:true
  coordinateSpace?:'planar'|'erp'
  sourceId:string
  revision:number
  application:{state:'pending'|'applied'|'unavailable';reason?:string}
}
/** A pending request is immutable until acknowledged or explicitly rejected.
 * Caller must reload the snapshot after success before making further edits. */
export function createArmingSaveSession(
  send:(request:ArmingSaveRequest,operationId:string)=>Promise<ArmingSaveResult>,
  newId:()=>string,
){
  let pending:{request:ArmingSaveRequest;id:string}|undefined,busy=false
  const settle=async()=>{
    if(!pending)throw Error('没有待确认的保存')
    const operation=pending
    try{
      const result=await send(structuredClone(operation.request),operation.id)
      if(result.saved!==true||result.sourceId!==operation.request.sourceId||result.revision!==operation.request.expectedRevision+1||
        !['pending','applied','unavailable'].includes(result.application?.state))throw Error('保存响应不匹配')
      pending=undefined
      return result
    }catch(error){
      const status=(error as {status?:number})?.status
      // Definitive validation/conflict responses did not commit this operation.
      if(status===400||status===401||status===403||status===404||status===409||status===422)pending=undefined
      throw error
    }
  }
  return {
    hasPending:()=>!!pending,
    save:async(request:ArmingSaveRequest)=>{
      if(busy)throw Error('正在保存')
      if(pending&&JSON.stringify(pending.request)!==JSON.stringify(request))throw Error('请先确认上次保存结果，再重新读取和修改')
      busy=true
      try{pending??={request:structuredClone(request),id:newId()};return await settle()}
      finally{busy=false}
    },
    retry:async()=>{
      if(busy)throw Error('正在保存')
      busy=true
      try{return await settle()}finally{busy=false}
    },
  }
}
