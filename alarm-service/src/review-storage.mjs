// Storage faults do not establish absence of visual evidence or a model verdict.
export function isStorageBusy(error){
 return error?.code===50||error?.codeName==='MaxTimeMSExpired'||
  ['MongoNetworkTimeoutError','MongoNetworkError','MongoServerSelectionError'].includes(error?.name)||
  error?.message==='evidence_capacity';
}
