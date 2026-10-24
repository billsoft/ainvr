import {expect,it} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {AlarmArmingStore} from '../store/alarmArmingStore.js';
const enabled=process.env.AINVR_ALARM_TEST_PG==='1';
async function isolated(run:(store:AlarmArmingStore,pool:Pool)=>Promise<void>){
  const schema='arming_'+randomUUID().replaceAll('-','');
  const connection={host:'127.0.0.1',port:25439,user:'alarm_test',database:'alarm_test'};
  const admin=new Pool(connection);await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({...connection,options:`-c search_path=${schema}`});
  try{
    for(const file of ['003_alarm_zones.sql','004_alarm_monitors.sql','005_alarm_triggers.sql','006_alarm_migration_review.sql','007_alarm_arming_storage.sql','009_flow_counters.sql','010_flow_counter_library.sql','011_flow_counter_history.sql'])
      await pool.query(readFileSync(new URL('../store/migrations/'+file,import.meta.url),'utf8'));
    await run(new AlarmArmingStore(pool),pool);
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
const definition={trigger_id:'person',name:'人员出现',behavior:'appearance',labels:[{label_id:'person',name:'人员'}],
  duration_ms:1000,alarm_enabled:true,state:'enabled',schedule:{mode:'always'}};
const source={stream_fingerprint:'a'.repeat(64),observed_at:'2026-10-20T00:00:00Z',channel_id:'ai',input_stream_id:'camera',geometry_revision:'g',label_map_version:'lm',tracking_available:true,
  labels:[{label_id:'person',name:'人员'}],width:1920,height:1080};
const lookup=async()=>source;
const zone=(id:string)=>({zone_id:id,channel_id:'camera',geometry_revision:'g',version:1,state:'active',name:id,
  points:[[.1,.1],[.8,.1],[.8,.8],[.1,.8]],edge_ids:['a','b','c','d']});
const assignment=(id:string,zoneId:string|null)=>({assignment_id:id,trigger_id:'person',input_stream_id:'camera',processor_id:'ai',
  zone_id:zoneId,zone_version:zoneId?1:null,geometry_revision:'g',label_map_version:'lm',entry_edges:[],exit_edges:[]});
const arming=()=>({source_id:'camera',geometry_revision:'g',zones:[zone('one'),zone('two')],
  assignments:[assignment('a','one'),assignment('b','two')]});
it.skipIf(!enabled)('PG 画面规格重画原子停用旧选用，保留历史且拒绝旧草稿覆盖',async()=>isolated(async(store,pool)=>{
  await store.saveDefinition(definition,0,'operator','d1',lookup);
  await store.saveArming(arming(),0,'operator','old',lookup,async()=>'g');
  const input={source_id:'camera',geometry_revision:'new',
    zones:[{...zone('redrawn'),geometry_revision:'new'}],
    assignments:[{...assignment('new-assignment','redrawn'),geometry_revision:'new'}]};
  const current=async()=>({...source,geometry_revision:'new'});
  await expect(store.saveArming(input,0,'operator','stale',current,async()=>'new')).rejects.toMatchObject({code:'version_conflict'});
  expect((await store.snapshot()).rules.map((r:any)=>r.id).sort()).toEqual(['a','b']);
  const result=await store.saveArming(input,1,'operator','reset',current,async()=>'new');
  expect(await store.saveArming(input,1,'operator','reset',async()=>null,async()=>null)).toEqual(result);
  expect((await store.snapshot()).rules.map((r:any)=>r.id)).toEqual(['new-assignment']);
  expect((await pool.query("SELECT assignment_id,active FROM alarm_trigger_assignments WHERE assignment_id IN ('a','b') ORDER BY assignment_id")).rows)
    .toEqual([{assignment_id:'a',active:false},{assignment_id:'b',active:false}]);
  expect((await pool.query('SELECT count(*)::int AS n FROM alarm_arming_versions')).rows[0].n).toBe(2);
  expect(await store.readArming('camera')).toMatchObject({revision:2,geometry_revision:'new',zones:input.zones});
  await expect(store.saveArming(arming(),1,'operator','restore-old',lookup,async()=>'new')).rejects.toMatchObject({code:'source_changed'});
  expect((await store.snapshot()).rules).toHaveLength(1);

}));
it.skipIf(!enabled)('PG 修改一个区域不会重置其他选用的执行版本，重复快照保留活动连续性',async()=>isolated(async store=>{
  await store.saveDefinition(definition,0,'operator','d1',lookup);
  await store.saveArming(arming(),0,'operator','a1',lookup,async()=>'g');
  const changed=arming();
  changed.zones[0]!.name='新区域名称';changed.zones[0]!.version=2;
  changed.assignments[0]!.zone_version=2;
  await store.saveArming(changed,1,'operator','a2',lookup,async()=>'g');
  const rules=(await store.snapshot()).rules;
  expect(rules).toEqual(expect.arrayContaining([
    expect.objectContaining({id:'a',version:2}),expect.objectContaining({id:'b',version:1}),
  ]));
  // Catalog observations refresh in time without changing the source identity.
  await store.saveArming(changed,2,'operator','a3',async()=>({...source,observed_at:'2026-10-20T00:00:01Z'}),async()=>'g');
  expect((await store.snapshot()).rules).toEqual(rules);
}));
it.skipIf(!enabled)('PG 无通道创建定义，多区域选用，重复保存不重复写入',async()=>isolated(async store=>{
  const saved=await store.saveDefinition(definition,0,'operator','d1',lookup);
  expect(saved.trigger.version).toBe(1);expect((await store.snapshot()).rules).toEqual([]);
  expect(await store.saveDefinition(definition,0,'operator','d1',lookup)).toEqual(saved);
  const result=await store.saveArming(arming(),0,'operator','a1',lookup,async()=>'g');
  expect(await store.saveArming(arming(),0,'operator','a1',lookup,async()=>'g')).toEqual(result);
  expect((await store.snapshot()).rules.map((r:any)=>r.id).sort()).toEqual(['a','b']);
  expect((await store.listDefinitions())[0].usages).toEqual([
    {assignment_id:'a',source_id:'camera',processor_id:'ai',zone_name:'one'},
    {assignment_id:'b',source_id:'camera',processor_id:'ai',zone_name:'two'},
  ]);
  expect((await store.readArming('camera'))?.revision).toBe(1);
}));
it.skipIf(!enabled)('PG 无效草稿整体回滚，删除区域必须同步解除引用',async()=>isolated(async store=>{
  await store.saveDefinition(definition,0,'operator','d1',lookup);
  await store.saveArming(arming(),0,'operator','a1',lookup,async()=>'g');
  await expect(store.saveArming({...arming(),zones:[]},1,'operator','bad',lookup,async()=>'g')).rejects.toThrow();
  expect((await store.readArming('camera'))?.revision).toBe(1);
  await store.saveArming({...arming(),zones:[],assignments:[]},1,'operator','clear',lookup,async()=>'g');
  expect((await store.snapshot()).rules).toEqual([]);
}));
it.skipIf(!enabled)('PG 共享定义编辑更新所有执行版本，暂停停止全部选用',async()=>isolated(async store=>{
  await store.saveDefinition(definition,0,'operator','d1',lookup);
  await store.saveArming(arming(),0,'operator','a1',lookup,async()=>'g');
  await store.saveDefinition({...definition,duration_ms:3000},1,'operator','d2',lookup);
  expect((await store.snapshot()).rules).toEqual(expect.arrayContaining([
    expect.objectContaining({id:'a',version:2,trigger_version:2,duration_ms:3000}),
    expect.objectContaining({id:'b',version:2,trigger_version:2,duration_ms:3000}),
  ]));
  await store.saveDefinition({...definition,state:'paused'},2,'operator','d3',lookup);
  expect((await store.snapshot()).rules).toEqual([]);
}));
it.skipIf(!enabled)('PG 冲突与来源失败保留原配置，操作号不能重用于其他内容',async()=>isolated(async store=>{
  await store.saveDefinition(definition,0,'operator','d1',lookup);
  await store.saveArming(arming(),0,'operator','a1',lookup,async()=>'g');
  await expect(store.saveArming(arming(),0,'operator','stale',lookup,async()=>'g')).rejects.toMatchObject({code:'version_conflict',statusCode:409});
  await expect(store.saveArming({...arming(),assignments:[]},1,'operator','a1',lookup,async()=>'g')).rejects.toMatchObject({code:'idempotency_conflict',statusCode:409});
  await expect(store.saveDefinition({...definition,duration_ms:2000},1,'operator','offline',async()=>null)).rejects.toMatchObject({code:'source_unavailable',statusCode:503});
  expect((await store.listDefinitions())[0].version).toBe(1);
}));
it.skipIf(!enabled)('PG 归档解除选用并保留区域和历史，旧布防草稿不能恢复选用',async()=>isolated(async(store,pool)=>{
  await store.saveDefinition(definition,0,'operator','d1',lookup);
  await store.saveArming(arming(),0,'operator','a1',lookup,async()=>'g');
  await store.saveDefinition({...definition,state:'archived'},1,'operator','archive',lookup);
  expect(await store.readArming('camera')).toMatchObject({revision:2,zones:arming().zones,assignments:[]});
  expect((await store.snapshot()).rules).toEqual([]);
  expect((await pool.query('SELECT count(*)::int AS count FROM alarm_arming_versions')).rows[0].count).toBe(2);
  expect((await store.listDefinitions())[0].usages).toEqual([]);
  await expect(store.saveArming(arming(),1,'operator','stale',lookup,async()=>'g')).rejects.toMatchObject({statusCode:409});
  await expect(store.saveArming(arming(),2,'operator','restore',lookup,async()=>'g')).rejects.toMatchObject({code:'trigger_unavailable'});
}));
it.skipIf(!enabled)('PG 并发编辑同一布防版本只有一笔成功，不留下半成品',async()=>isolated(async(store,pool)=>{
  await store.saveDefinition(definition,0,'operator','d1',lookup);
  await store.saveArming(arming(),0,'operator','a1',lookup,async()=>'g');
  const results=await Promise.allSettled([
    store.saveArming({...arming(),assignments:[assignment('a','one')]},1,'operator','edit1',lookup,async()=>'g'),
    store.saveArming({...arming(),assignments:[assignment('b','two')]},1,'operator','edit2',lookup,async()=>'g'),
  ]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const rejected=results.find(r=>r.status==='rejected') as PromiseRejectedResult;
  expect(rejected.reason).toMatchObject({code:'version_conflict',statusCode:409});
  expect((await store.readArming('camera'))?.revision).toBe(2);
  expect((await store.snapshot()).rules).toHaveLength(1);
  expect((await pool.query('SELECT count(*)::int AS count FROM alarm_arming_versions')).rows[0].count).toBe(2);
}));
it.skipIf(!enabled)('PG 没有选用也校验真实来源，成功重试不依赖当前在线状态',async()=>isolated(async store=>{
  const input={...arming(),assignments:[]};
  await expect(store.saveArming(input,0,'operator','new',lookup,async()=>null)).rejects.toMatchObject({code:'source_unavailable'});
  await expect(store.saveArming(input,0,'operator','new',lookup,async()=>'changed')).rejects.toMatchObject({code:'source_changed'});
  expect(await store.readArming('camera')).toBeNull();
  const saved=await store.saveArming(input,0,'operator','new',lookup,async()=>'g');
  expect(await store.saveArming(input,0,'operator','new',lookup,async()=>null)).toEqual(saved);
}));

it.skipIf(!enabled)('PG preserves ERP seam topology in source, compiled selection and idempotent reread',async()=>isolated(async(store)=>{
 await store.saveDefinition(definition,0,'operator','d1',lookup);
 const input={source_id:'camera',coordinate_space:'erp',geometry_revision:'g',zones:[{...zone('seam'),erp_wrap:true,points:[[.9,.3],[.1,.3],[.1,.7],[.9,.7]]}],assignments:[assignment('seam-selection','seam')]};
 await expect(store.saveArming({...input,coordinate_space:'planar'},0,'operator','erp-invalid',lookup,async()=>'g')).rejects.toThrow(/全景/);
 await store.saveArming(input,0,'operator','erp-save',lookup,async()=>'g');
 expect((await store.readArming('camera'))?.zones[0]).toMatchObject({erp_wrap:true,points:input.zones[0]!.points});
 expect((await store.snapshot()).rules[0]).toMatchObject({erp_wrap:true,points:input.zones[0]!.points});
 await expect(store.saveArming({...input,coordinate_space:'planar'},0,'operator','erp-invalid',lookup,async()=>'g')).rejects.toThrow(/全景/);
 await store.saveArming(input,0,'operator','erp-save',lookup,async()=>'g');
 expect((await store.readArming('camera'))?.revision).toBe(1);
}));

it.skipIf(!enabled)('PG processor-scoped arming isolates shared input, preserves foreign rules, and supports retries',async()=>isolated(async store=>{
 const lookupBoth=async(id:string)=>({...source,channel_id:id});
 await store.saveDefinition(definition,0,'operator','scope-definition',lookupBoth);
 const full=arming();full.assignments[1]!.processor_id='ai2';
 await store.saveArming(full,0,'operator','scope-initial',lookupBoth,async()=>'g');
 const before=(await store.snapshot()).rules.find((r:any)=>r.id==='b');
 const mine=await store.readArming('camera','ai');
 expect(mine.zones).toHaveLength(1);expect(mine.assignments.map((a:any)=>a.assignment_id)).toEqual(['a']);
 const {revision,...draft}=mine;
 draft.zones[0].name='output one';draft.zones[0].version++;
 draft.assignments[0].zone_version++;
 const scoped={...draft,processor_id:'ai'};
 const unavailableOther=async(id:string)=>id==='ai'?({...source}):null;
 const result=await store.saveArming(scoped,revision,'operator','scope-save',unavailableOther,async()=>'g');
 expect(await store.saveArming(scoped,revision,'operator','scope-save',async()=>null,async()=>null)).toEqual(result);
 expect((await store.snapshot()).rules.find((r:any)=>r.id==='b')).toEqual(before);
 expect((await store.readArming('camera','ai2')).assignments.map((a:any)=>a.assignment_id)).toEqual(['b']);
 const now=await store.readArming('camera','ai');
 const {revision:next,...remove}=now;remove.assignments=[];
 await store.saveArming({...remove,processor_id:'ai'},next,'operator','scope-unbind',unavailableOther,async()=>'g');
 expect((await store.readArming('camera','ai')).zones).toHaveLength(1);
 expect((await store.readArming('camera','ai2')).zones).toHaveLength(1);
 await expect(store.saveArming({...remove,processor_id:'ai2'},next+1,'operator','scope-steal',lookupBoth,async()=>'g')).rejects.toMatchObject({code:'invalid_arming'});
 await expect(store.saveArming({...remove,processor_id:'ai'},next,'operator','scope-stale',lookupBoth,async()=>'g')).rejects.toMatchObject({code:'version_conflict'});
}));

it.skipIf(!enabled)('PG separate AI outputs can use same zone name and counter without merging counts or deleting foreign bindings',async()=>isolated(async store=>{
 const lookupBoth=async(id:string)=>({...source,channel_id:id});
 const counter={counter_id:'visitors',name:'客流',labels:[{label_id:'person',name:'人员'}],method:'zone',outputs:'both',names:{in:'进',out:'出'},occupancy:true,max_gap_ms:1000,state:'enabled'};
 await store.saveCounter(counter,0,'operator','counter',lookupBoth);
 const make=(id:string)=>{
  const z={...zone('zone-'+id),name:'热区 1',edge_ids:['top','right','bottom','left'],points:[[.2,.2],[.8,.2],[.8,.8],[.2,.8]]};
  return {processor_id:id,source_id:'camera',geometry_revision:'g',zones:[z],assignments:[],counter_bindings:[{binding_id:'flow-count-'+id,counter_id:'visitors',input_stream_id:'camera',processor_id:id,zone_id:z.zone_id,zone_version:1,geometry_revision:'g',label_map_version:'lm',direction:{kind:'edges',entry:['left'],exit:['right']}}]};
 };
 await store.saveArming(make('ai'),0,'operator','first',lookupBoth,async()=>'g');
 await store.saveArming(make('ai2'),1,'operator','second',lookupBoth,async()=>'g');
 expect((await store.readArming('camera','ai')).counter_bindings.map((b:any)=>b.binding_id)).toEqual(['flow-count-ai']);
 expect((await store.readArming('camera','ai2')).counter_bindings.map((b:any)=>b.binding_id)).toEqual(['flow-count-ai2']);
 const other=(await store.snapshot()).rules.find((r:any)=>r.id==='flow-count-ai2');
 await store.saveArming({...make('ai'),zones:[],counter_bindings:[]},2,'operator','remove-first',async id=>id==='ai'?source:null,async()=>'g');
 expect((await store.snapshot()).rules).toEqual([other]);
 const history=await store.counterBindings(['visitors']);
 expect(history.find(b=>b.binding_id==='flow-count-ai')?.active).toBe(false);
 expect(history.find(b=>b.binding_id==='flow-count-ai2')?.active).toBe(true);
}));


it.skipIf(!enabled)('PG archive preserves legacy single and shared zone ownership without changing geometry',async()=>isolated(async(store)=>{
 const both=async(id:string)=>({...source,channel_id:id});
 await store.saveDefinition(definition,0,'operator','legacy-def',both);
 await store.saveArming({...arming(),assignments:[assignment('a','one'),assignment('b','two'),{...assignment('c','two'),processor_id:'ai2'}]},0,'operator','legacy-save',both,async()=>'g');
 await store.saveDefinition({...definition,state:'archived'},1,'operator','legacy-archive',both);
 const first=await store.readArming('camera','ai'),second=await store.readArming('camera','ai2');
 expect(first.zones.map((z:any)=>z.zone_id)).toEqual(['one','two']);
 expect(second.zones.map((z:any)=>z.zone_id)).toEqual(['two']);
 expect(first.zones.every((z:any)=>z.version===1)).toBe(true);
 expect(first.assignments).toEqual([]);
 const {revision,...draft}=second;
 draft.zones[0].name='steal shared';
 await expect(store.saveArming({...draft,processor_id:'ai2'},revision,'operator','shared-edit',both,async()=>'g')).rejects.toMatchObject({code:'invalid_arming'});
}));

it.skipIf(!enabled)('PG deleting last legacy counter retains zone in its AI output and retry is idempotent',async()=>isolated(async(store)=>{
 const counter={counter_id:'visitors',name:'visitors',labels:[{label_id:'person',name:'人员'}],method:'zone',outputs:'both',names:{in:'进',out:'出'},occupancy:true,max_gap_ms:1000,state:'enabled'};
 await store.saveCounter(counter,0,'operator','legacy-counter',lookup);
 const z=zone('one');
 const input={source_id:'camera',geometry_revision:'g',zones:[z],assignments:[],counter_bindings:[{binding_id:'flow-count-legacy',counter_id:'visitors',input_stream_id:'camera',processor_id:'ai',zone_id:'one',zone_version:1,geometry_revision:'g',label_map_version:'lm',direction:{kind:'edges',entry:['d'],exit:['b']}}]};
 await store.saveArming(input,0,'operator','legacy-counter-save',lookup,async()=>'g');
 const result=await store.beginDeleteCounter('visitors',1,'operator','legacy-delete');
 expect(await store.beginDeleteCounter('visitors',1,'operator','legacy-delete')).toEqual(result);
 const saved=await store.readArming('camera','ai');
 expect(saved.zones).toHaveLength(1);expect(saved.zones[0]).toMatchObject({processor_id:'ai',version:1,points:z.points});
 expect(saved.counter_bindings).toEqual([]);
 expect((await store.readArming('camera','ai2')).zones).toEqual([]);
}));

it.skipIf(!enabled)('PG removing a scoped association preserves all legacy shared owners',async()=>isolated(async(store)=>{
 const both=async(id:string)=>({...source,channel_id:id});
 await store.saveDefinition(definition,0,'operator','shared-def',both);
 await store.saveArming({...arming(),zones:[zone('one')],assignments:[assignment('a','one'),{...assignment('b','one'),processor_id:'ai2'}]},0,'operator','shared-save',both,async()=>'g');
 const {revision,...draft}=await store.readArming('camera','ai');
 draft.assignments=[];
 await store.saveArming({...draft,processor_id:'ai'},revision,'operator','shared-remove',both,async()=>'g');
 expect((await store.readArming('camera','ai')).zones).toHaveLength(1);
 expect((await store.readArming('camera','ai2')).zones).toHaveLength(1);
 expect((await store.snapshot()).rules).toHaveLength(1);
 const saved=await store.readArming('camera','ai2');
 const {revision:rev,...uiDraft}=saved;
 uiDraft.zones=uiDraft.zones.map(({processor_id,legacy_processor_ids,...z}:any)=>z);
 await store.saveArming({...uiDraft,processor_id:'ai2'},rev,'operator','shared-ui-save',both,async()=>'g');
 expect((await store.readArming('camera','ai')).zones).toHaveLength(1);
}));
