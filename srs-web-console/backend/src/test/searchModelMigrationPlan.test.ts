import {describe,expect,it} from 'vitest';
import {searchMigrationPlanPayloadSchema,searchMigrationPlanFingerprint,searchMigrationSourceIdsDigest,
  migrationPlanChildCount,migrationPlanChild,migrationPlanChildRequestId,migrationPlanWindows,migrationPlanFinalSpec} from '../services/searchModelMigrationPlan.js';
import {searchModelMigrationFingerprint,searchModelMigrationPayloadSchema} from '../services/searchModelMigrationContract.js';
const id=(n:number)=>`00000000-0000-4000-8000-${n.toString().padStart(12,'0')}`;
const h=(n:number)=>n.toString(16).repeat(64),day=86400000;
const ids=Array.from({length:1024},(_,i)=>id(i+1));
const from=Date.parse('2025-10-01T13:17:29.000Z');
const plan={schema_version:'search-reencode-plan-v1' as const,purpose:'reencode_plan' as const,
  source:{package_id:'source',package_sha256:h(1),model_version:`search-v1-${h(1)}`},
  target:{package_id:'target',package_sha256:h(2),model_version:`search-v1-${h(2)}`},
  config_revision:h(3),storage_generation:h(4),acceptance_criteria_sha256:h(5),
  source_ids_sha256:searchMigrationSourceIdsDigest(ids),source_count:ids.length,
  extent:{from_ms:from,to_ms:from+365*day,source_high_watermark:'9007199254740993'}};
describe('bounded whole-history migration planning',()=>{
  it('uses explicit empty extents and no fake time window/ordinal or child task',()=>{
    const empty={...plan,extent:{from_ms:null,to_ms:null,source_high_watermark:'0'}};
    expect(searchMigrationPlanPayloadSchema.parse(empty)).toEqual(empty);expect(migrationPlanChildCount(empty)).toBe(0);
    expect(()=>migrationPlanChild(id(5000),empty,ids,0)).toThrow('migration_empty_plan_has_no_children');
    expect(searchMigrationPlanPayloadSchema.safeParse({...empty,extent:{...empty.extent,to_ms:1}}).success).toBe(false);
    expect(searchMigrationPlanPayloadSchema.safeParse({...empty,extent:{...empty.extent,source_high_watermark:'1'}}).success).toBe(false);
    const final=migrationPlanFinalSpec(plan,{from_ms:null,to_ms:null,high_watermark:'0'});
    expect(final.extent).toEqual({from_ms:null,to_ms:null,source_high_watermark:plan.extent.source_high_watermark});expect(migrationPlanChildCount(final,true)).toBe(0);
    const arrived=migrationPlanFinalSpec(empty,{from_ms:1000,to_ms:2000,high_watermark:'5'});
    expect(migrationPlanChildCount(arrived,true)).toBe(11);expect(migrationPlanChild(id(5000),arrived,ids,0,1,'0').source_after_watermark).toBe('0');
  });
  it('covers1024 sources/365 actual days by at most132 deterministic bounded children without a gap',()=>{
    expect(migrationPlanChildCount(plan)).toBe(132);
    const coverage=new Map(ids.map(value=>[value,[] as {from:number;to:number}[]]));
    for(let index=0;index<132;index++){
      const child=migrationPlanChild(id(5000),plan,ids,index);
      expect(child.scope.channel_ids.length).toBeLessThanOrEqual(100);
      const start=Date.parse(child.scope.from),end=Date.parse(child.scope.to);
      expect(end-start).toBeLessThanOrEqual(31*day);
      expect(Math.floor((end-1)/day)-Math.floor(start/day)+1).toBeLessThanOrEqual(31);
      expect(child.source_high_watermark).toBe(plan.extent.source_high_watermark);
      expect(child).toMatchObject({plan_id:id(5000),plan_round:0,partition_index:index,source_after_watermark:'0'});
      for(const channel of child.scope.channel_ids)coverage.get(channel)!.push({from:start,to:end});
      expect(Buffer.byteLength(JSON.stringify(child))).toBeLessThan(12000);
    }
    for(const intervals of coverage.values()){
      expect(intervals[0].from).toBe(plan.extent.from_ms);expect(intervals.at(-1)!.to).toBe(plan.extent.to_ms);
      intervals.slice(1).forEach((value,index)=>expect(value.from).toBe(intervals[index].to));
    }
    expect(Buffer.byteLength(JSON.stringify(plan))).toBeLessThan(2000);
    expect(JSON.stringify(plan)).not.toContain(ids[0]);
  });
  it('orders sources by stable IDs and rejects a changed catalog under the same requested plan',()=>{
    expect(searchMigrationSourceIdsDigest([...ids].reverse())).toBe(plan.source_ids_sha256);
    expect(migrationPlanChild(id(5000),plan,[...ids].reverse(),0)).toEqual(migrationPlanChild(id(5000),plan,ids,0));
    expect(()=>migrationPlanChild(id(5000),plan,ids.slice(1),0)).toThrow('migration_source_catalog_changed');
    expect(()=>migrationPlanChild(id(5000),plan,[id(9000),...ids.slice(1)],0)).toThrow('migration_source_catalog_changed');
  });
  it('keeps initial and final-delta child identities separate while preserving target evidence identity outside this control protocol',()=>{
    const first=migrationPlanChild(id(5000),plan,ids,0),delta=migrationPlanChild(id(5000),plan,ids,0,1,'100');
    expect(searchModelMigrationFingerprint(delta)).not.toBe(searchModelMigrationFingerprint(first));
    expect(migrationPlanChildRequestId(id(5000),0,0)).not.toBe(migrationPlanChildRequestId(id(5000),1,0));
    expect(migrationPlanChildRequestId(id(5000),0,0)).toBe(migrationPlanChildRequestId(id(5000),0,0));
    expect(migrationPlanChildRequestId(id(5000),0,0)).toMatch(/^[a-f0-9-]{14}8[a-f0-9-]{4}[89ab][a-f0-9-]{16}$/);
  });
  it('pins every source/target/context/watermark/criterion change into the immutable parent fingerprint',()=>{
    const before=searchMigrationPlanFingerprint(plan);
    for(const change of [{config_revision:h(6)},{storage_generation:h(7)},{acceptance_criteria_sha256:h(8)},
      {target:{...plan.target,model_version:`search-v1-${h(9)}`}},{extent:{...plan.extent,source_high_watermark:'9007199254740994'}}])
      expect(searchMigrationPlanFingerprint({...plan,...change})).not.toBe(before);
  });
  it('rejects unbounded or invalid ranges/catalogs rather than silently truncating the remaining work',()=>{
    expect(searchMigrationPlanPayloadSchema.safeParse({...plan,source_count:1025}).success).toBe(false);
    expect(searchMigrationPlanPayloadSchema.safeParse({...plan,extent:{...plan.extent,to_ms:plan.extent.to_ms+1}}).success).toBe(false);
    expect(()=>migrationPlanChild(id(5000),plan,ids,132)).toThrow();
    expect(()=>searchMigrationSourceIdsDigest([...ids.slice(0,1023),ids[0]])).toThrow();
    expect(()=>migrationPlanWindows(Number.NaN,1)).toThrow();
    expect(()=>migrationPlanWindows(2,1)).toThrow();
  });
  it('requires all parent linkage fields together and a delta lower watermark not above its frozen upper bound',()=>{
    const first=migrationPlanChild(id(5000),plan,ids,0);
    for(const patch of [{plan_round:undefined},{plan_id:undefined},{partition_index:undefined},{source_after_watermark:'9007199254740994'}])
      expect(searchModelMigrationPayloadSchema.safeParse({...first,...patch}).success).toBe(false);
    expect(searchModelMigrationPayloadSchema.safeParse({...first,source_after_watermark:'1.0'}).success).toBe(false);
  });
});
