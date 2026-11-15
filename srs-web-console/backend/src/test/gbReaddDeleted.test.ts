import {it,expect} from 'vitest';
import {Pool} from 'pg';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PgConfigStore} from '../store/pgStore.js';
import {GB28181Store} from '../store/gb28181Store.js';

// A customer deletes a GB channel in the channel list, later wants it back. The
// sync disables the mapping and keeps the deleted input id for history; that
// stale id must not block adding the camera channel again through the wizard,
// a single bind or an NVR batch bind. A mapping whose input still exists stays protected.
it.skipIf(process.env.AINVR_GB_TEST_PG!=='1')('a deleted GB input does not block adding its camera channel again',async()=>{
 const connection={host:'127.0.0.1',port:25439,user:'alarm_test',database:'alarm_test'};
 const schema='gb_'+randomUUID().replaceAll('-',''),admin=new Pool(connection),dir=mkdtempSync(join(tmpdir(),'ainvr-gb-'));
 const key=join(dir,'key');writeFileSync(key,randomBytes(32),{mode:0o600});
 await admin.query(`CREATE SCHEMA ${schema}`);
 const pg=new PgConfigStore({poolConfig:{...connection,options:`-c search_path=${schema}`},masterKeyPath:key});
 try{
  for(const file of ['001_initial_schema.sql','012_gb28181.sql','013_gb_media_addresses.sql','014_gb_channel_config.sql'])await pg.pool.query(readFileSync(new URL('../store/migrations/'+file,import.meta.url),'utf8'));
  const existing=new Set<string>();
  const store=new GB28181Store(pg,async id=>existing.has(id));
  const device='34020000001320000001',channels=['34020000001320000002','34020000001320000003','34020000001320000004'];
  let rev=(await store.readSettings()).revision;
  rev=(await store.saveDevice({id:device,name:'设备',version:'auto',enabled:true,mediaIPs:[],password:'test-secret-password'},rev,'test')).revision;
  for(const c of channels)await pg.pool.query('INSERT INTO gb28181_catalog(device_id,channel_id,document) VALUES($1,$2,$3)',[device,c,{name:c}]);
  const config={name:'甲板',description:'',protocols:['flv'],primary:'flv'};
  // Each channel was added once, received an input, then that input was deleted
  // and the sync disabled the mapping (as gb28181Sync does).
  for(const c of channels){
   rev=(await store.saveChannel({deviceId:device,channelId:c,transport:'udp',enabled:true,config},rev,'test')).revision;
   await pg.pool.query('UPDATE gb28181_bindings SET input_id=$1,enabled=false WHERE channel_id=$2',[randomUUID(),c]);
  }
  const live=randomUUID();existing.add(live);
  await pg.pool.query('UPDATE gb28181_bindings SET input_id=$1 WHERE channel_id=$2',[live,channels[2]]);
  const inputOf=async(c:string)=>(await pg.pool.query('SELECT input_id,enabled FROM gb28181_bindings WHERE channel_id=$1',[c])).rows[0];

  // Wizard: offered as free, then accepted; the stale input id is released so a new input is created.
  const free=await store.channelInputs(device);
  expect(free.find(i=>i.id===channels[0])?.input_id).toBeNull();
  expect(free.find(i=>i.id===channels[2])?.input_id).toBe(live);
  // The wizard refreshes the list from the device catalog endpoint as well.
  const catalog=await store.catalog(device);
  expect(catalog.find(i=>i.id===channels[0])?.input_id).toBeNull();
  expect(catalog.find(i=>i.id===channels[2])?.input_id).toBe(live);
  rev=(await store.saveChannel({deviceId:device,channelId:channels[0],transport:'tcp-passive',enabled:true,config},rev,'test')).revision;
  expect(await inputOf(channels[0])).toMatchObject({input_id:null,enabled:true});

  // Single bind and NVR batch bind release the stale id too; otherwise the sync disables them again.
  rev=(await store.bind(device,channels[1],'udp',true,rev,'test')).revision;
  expect(await inputOf(channels[1])).toMatchObject({input_id:null,enabled:true});
  rev=(await store.bind(device,channels[1],'udp',false,rev,'test')).revision;
  await pg.pool.query('UPDATE gb28181_bindings SET input_id=$1 WHERE channel_id=$2',[randomUUID(),channels[1]]);
  rev=(await store.bindMany(device,[channels[1]],'tcp-active',rev,'test')).revision;
  expect(await inputOf(channels[1])).toMatchObject({input_id:null,enabled:true});

  // A mapping whose input still exists is not taken over by the wizard.
  await expect(store.saveChannel({deviceId:device,channelId:channels[2],transport:'udp',enabled:true,config},rev,'test')).rejects.toMatchObject({statusCode:409});
  expect((await inputOf(channels[2])).input_id).toBe(live);
 }finally{
  await pg.pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();rmSync(dir,{recursive:true,force:true});
 }
});
