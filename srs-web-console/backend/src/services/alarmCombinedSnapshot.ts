interface Snapshot {schema_version:string;revision:string;rules:unknown[]}
interface Source {snapshot:()=>Promise<Snapshot>}
/** Transitional single publisher: legacy and assignment rules share a PG revision.
 * Never publish mismatched revisions or allow one source to erase the other. */
export class AlarmCombinedSnapshot {
 constructor(private legacy:Source,private assignments:Source){}
 async snapshot():Promise<Snapshot>{
  for(let attempt=0;attempt<3;attempt++){
   const a=await this.legacy.snapshot(),b=await this.assignments.snapshot();
   if(a.revision!==b.revision)continue;
   const rules=[...a.rules,...b.rules],ids=new Set<string>();
   for(const rule of rules){
    const id=(rule as {id?:unknown})?.id;
    if(typeof id!=='string'||ids.has(id))throw Error('Duplicate or invalid execution identity');
    ids.add(id);
   }
   return {schema_version:'1.0',revision:a.revision,rules:rules.sort((x,y)=>String((x as {id:string}).id).localeCompare((y as {id:string}).id))};
  }
  throw Error('Configuration changed while building snapshot');
 }
}
