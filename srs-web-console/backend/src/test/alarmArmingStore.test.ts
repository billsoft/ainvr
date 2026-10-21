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
    for(const file of ['003_alarm_zones.sql','004_alarm_monitors.sql','005_alarm_triggers.sql','006_alarm_migration_review.sql','007_alarm_arming_storage.sql'])
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
