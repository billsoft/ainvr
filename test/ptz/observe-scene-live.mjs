// Read-only, bounded experiment observer. No camera or database mutations.
import pg from '../../srs-web-console/backend/node_modules/pg/lib/index.js';
import {mkdir,writeFile,appendFile} from 'node:fs/promises';
import {captureScene} from '../../srs-web-console/backend/dist/services/sceneCapture.js';
process.loadEnvFile('deploy/s100p/runtime/backend.env');
const onvif=process.argv.includes('--onvif');
const source=onvif?'eabb3379-11b4-43c3-bba3-e2eb2d295a12':'34a1f850-8d5b-4dd8-8111-2ce27b2dbe63';
const root='test/results/scene-live-repeat-20261121';
const label=process.argv[2];
if(!label||!/^[a-z0-9-]{1,60}$/.test(label))throw Error('label required');
await mkdir(root,{recursive:true});
const c=new pg.Client({host:process.env.CONFIG_PG_HOST,port:Number(process.env.CONFIG_PG_PORT??5432),user:process.env.CONFIG_PG_USER,password:process.env.CONFIG_PG_PASSWORD,database:process.env.CONFIG_PG_DATABASE});
await c.connect();
try{
 const read=async()=>({at:new Date().toISOString(),rows:(await c.query('SELECT zone_id,revision,zone_version,reference_frame_id,reference_points,current_points,state,reason,changed_at,checked_at,pose,evidence FROM arming_scene_zones WHERE source_id=$1',[source])).rows});
 if(process.argv.includes('--watch')){
  for(let i=0;i<1200;i++){
   await appendFile(root+'/'+label+'.jsonl',JSON.stringify(await read())+'\n');
   await new Promise(r=>setTimeout(r,1000));
  }
 }else{
  const data=await read();
  await writeFile(root+'/'+label+'.json',JSON.stringify(data,null,2));
  if(process.argv.includes('--capture')){
   const lock=(await c.query("SELECT pg_try_advisory_lock(hashtextextended('arming-scene-hardware',0)) AS held")).rows[0].held;
   if(!lock)throw Error('background capture active; retry snapshot later');
   try{const image=await captureScene({app:'live',stream:onvif?'onvif_c8a896':'gb_c87e48c5d343461388051345095a63a1',width:1280,height:960});
    await writeFile(root+'/'+label+'.jpg',image.bytes);
    await writeFile(root+'/'+label+'-capture.json',JSON.stringify({at:image.at,w:image.w,h:image.h,state:await read()}));
   }finally{await c.query("SELECT pg_advisory_unlock(hashtextextended('arming-scene-hardware',0))");}
  }
  console.log(JSON.stringify({label,...data}));
 }
}finally{await c.end();}
