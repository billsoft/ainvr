import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm, utimes, writeFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import Fastify from 'fastify';
import { FloorPlanImages, parseFloorPlanJpeg, selectedFloorPlanDirectory } from '../services/floorPlanImages.js';
import { FloorPlans } from '../store/floorPlans.js';
import { floorPlanRoutes } from '../routes/floorPlanRoutes.js';
import { osHelperConfigFromEnv, storageRequest } from '../services/osHelperClient.js';

const jpegPath='/home/sunrise/ainvr/test/runtime/ai-codecs/jpeg.jpg';
const volume={id:'uuid-1',device:'/dev/disk1',filesystem:'ext4',mountPath:'/mnt/ssd',system:false,readOnly:false,selectable:true,state:'mounted'};
describe('floor plan images',()=>{
  it('accepts a real JPEG header and rejects altered dimensions and non-JPEG',async()=>{
    const data='data:image/jpeg;base64,'+(await readFile(jpegPath)).toString('base64');
    expect(parseFloorPlanJpeg(data,640,320).length).toBeGreaterThan(100);
    expect(()=>parseFloorPlanJpeg(data,641,320)).toThrow();
    expect(()=>parseFloorPlanJpeg(data.replace('image/jpeg','image/png'),640,320)).toThrow();
    expect(()=>parseFloorPlanJpeg(data.slice(0,-8),640,320)).toThrow();
  });
  it('requires one unambiguous online external volume; existing images resolve their own generation',()=>{
    const v=selectedFloorPlanDirectory({volumes:[volume]})!;
    expect(v.root).toBe('/mnt/ssd');
    expect(selectedFloorPlanDirectory({volumes:[{...volume,system:true}]})).toBeNull();
    expect(selectedFloorPlanDirectory({volumes:[{...volume,state:'unmounted'}]})).toBeNull();
    expect(selectedFloorPlanDirectory({volumes:[volume,volume]})).toBeNull();
    const another={...volume,id:'uuid-2',device:'/dev/disk2',mountPath:'/mnt/ssd2'};
    expect(selectedFloorPlanDirectory({volumes:[volume,another]})).toBeNull();
    expect(selectedFloorPlanDirectory({volumes:[volume,another]},v.generation)).toEqual(v);
  });
  it('never writes to the system filesystem',async()=>{
    const images=new FloorPlanImages(async()=>({root:'/tmp',generation:'g',device:'/dev/null'}));
    await expect(images.publish(Buffer.from('x'),1,1)).rejects.toMatchObject({code:'storage_unavailable'});
  });
});

const integration=process.env.AINVR_FLOOR_TEST_PG === '1';
it.skipIf(!integration)('authenticated API, optimistic writes, idempotency and SSD retention in isolated PostgreSQL schema',async()=>{
  process.loadEnvFile('/home/sunrise/ainvr/deploy/s100p/runtime/backend.env');
  const connection={host:process.env.CONFIG_PG_HOST,port:Number(process.env.CONFIG_PG_PORT),user:process.env.CONFIG_PG_USER,
    password:process.env.CONFIG_PG_PASSWORD,database:process.env.CONFIG_PG_DATABASE};
  const schema='floor_test_'+randomUUID().replaceAll('-','');
  const admin=new Pool(connection);
  let pool:Pool|undefined, app:ReturnType<typeof Fastify>|undefined, root:string|undefined, created=false;
  try {
    await admin.query('CREATE SCHEMA '+schema); created=true;
    pool=new Pool({...connection,options:'-c search_path='+schema});
    for (const migration of ['025_floor_plans.sql','026_floor_plan_tombstones.sql'])
      await pool.query(await readFile(new URL('../store/migrations/'+migration,import.meta.url),'utf8'));
    const helper=osHelperConfigFromEnv();
    expect(helper).not.toBeNull();
    const selected=selectedFloorPlanDirectory(await storageRequest(helper!,'/storage/volumes'));
    expect(selected?.device).toBeTruthy();
    expect(selected?.root).toBe('/mnt/ainvr-ssd');
    root=await mkdtemp(selected!.root+'/ainvr-floor-plan-test-');
    let online=true;
    const images=new FloorPlanImages(async()=>online ? {...selected!,root:root!} : null);
    const wrongDevice=new FloorPlanImages(async()=>({...selected!,root:root!,device:'/dev/null'}));
    await expect(wrongDevice.publish(Buffer.from('x'),1,1)).rejects.toMatchObject({code:'storage_unavailable'});
    const store=new FloorPlans(pool,images);
    app=Fastify();
    await app.register(floorPlanRoutes,{store,principal:async req=>req.headers['x-console-token']==='test-token'?'tester':null});
    const headers={'x-console-token':'test-token','idempotency-key':'create-1'};
    const jpeg=await readFile(jpegPath), data='data:image/jpeg;base64,'+jpeg.toString('base64');
    const plan={id:'p1',name:'Plan',image:{data,w:640,h:320},shapes:[],placements:{z:{x:0,y:0,w:40,h:30}}};
    expect((await app.inject({url:'/floor-plans'})).statusCode).toBe(401);
    const save=()=>app!.inject({method:'POST',url:'/floor-plans',headers,payload:{plan,expected_version:0}});
    const [createdPlan,retry]=await Promise.all([save(),save()]);
    expect(createdPlan.statusCode,createdPlan.body).toBe(200);
    expect(retry.json()).toEqual(createdPlan.json());
    const saved=createdPlan.json(), ref=saved.plan.image.ref;
    expect(saved).toMatchObject({version:1,plan:{image:{w:640,h:320}}});
    expect((await app.inject({url:'/floor-plans/images/'+ref})).statusCode).toBe(401);
    const read=await app.inject({url:'/floor-plans/images/'+ref,headers});
    expect(read.statusCode).toBe(200); expect(read.rawPayload.equals(jpeg)).toBe(true);
    const keyConflict=await app.inject({method:'POST',url:'/floor-plans',headers,payload:{plan:{...plan,name:'changed'},expected_version:0}});
    expect(keyConflict.statusCode).toBe(409);expect(keyConflict.json().error.code).toBe('idempotency_conflict');
    const updatePlan={...plan,image:saved.plan.image};
    const edit=(key:string,name:string)=>app!.inject({method:'POST',url:'/floor-plans',headers:{...headers,'idempotency-key':key},payload:{plan:{...updatePlan,name},expected_version:1}});
    const pair=await Promise.all([edit('edit-a','A'),edit('edit-b','B')]);
    expect(pair.map(r=>r.statusCode).sort()).toEqual([200,409]);
    expect(pair.find(r=>r.statusCode===409)!.json().error.code).toBe('version_conflict');
    expect((await app.inject({url:'/floor-plans',headers})).json().items).toHaveLength(1);
    const replayAfterEdit=await save();
    expect(replayAfterEdit.statusCode).toBe(409);
    expect(replayAfterEdit.json()).toMatchObject({error:{code:'operation_superseded'},current:{version:2}});
    // Replacing the image invalidates the prior successful operation response.
    const replacementPlan={...plan,id:'replace-me'};
    const replaceHeaders={...headers,'idempotency-key':'replacement-create'};
    const createReplacement=()=>app!.inject({method:'POST',url:'/floor-plans',headers:replaceHeaders,payload:{plan:replacementPlan,expected_version:0}});
    const initialReplacement=await createReplacement();
    expect(initialReplacement.statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:'/floor-plans',headers:{...headers,'idempotency-key':'replacement-update'},
      payload:{plan:replacementPlan,expected_version:1}})).statusCode).toBe(200);
    const supersededReplacement=await createReplacement();
    expect(supersededReplacement.statusCode).toBe(409);
    expect(supersededReplacement.json().error.code).toBe('operation_superseded');
    expect((await app.inject({url:'/floor-plans/images/'+initialReplacement.json().plan.image.ref,headers})).statusCode).toBe(404);
    expect((await app.inject({method:'POST',url:'/floor-plans/replace-me/delete',headers:{...headers,'idempotency-key':'replacement-delete'},
      payload:{expected_version:2}})).statusCode).toBe(200);
    online=false;
    expect((await app.inject({url:'/floor-plans/images/'+ref,headers})).statusCode).toBe(503);
    const unavailable=await app.inject({method:'POST',url:'/floor-plans',headers:{...headers,'idempotency-key':'offline'},payload:{plan:{...plan,id:'offline'},expected_version:0}});
    expect(unavailable.statusCode).toBe(503); expect(unavailable.json().error.code).toBe('storage_unavailable');
    online=true;
    const oldFile=root+'/ainvr-floor-plans/'+ref+'.jpg';
    const stale=new Date(Date.now()-2*86400000); await utimes(oldFile,stale,stale);
    // A failure after a replacement was published must not delete the old image.
    await pool.query("ALTER TABLE floor_plan_operations ADD CONSTRAINT reject_test_key CHECK (operation_key <> 'forced-failure')");
    const failed=await app.inject({method:'POST',url:'/floor-plans',headers:{...headers,'idempotency-key':'forced-failure'},payload:{plan,expected_version:2}});
    expect(failed.statusCode).toBe(503);
    expect((await app.inject({url:'/floor-plans/images/'+ref,headers})).statusCode).toBe(200);
    await pool.query('ALTER TABLE floor_plan_operations DROP CONSTRAINT reject_test_key');
    const orphan=randomUUID();await writeFile(root+'/ainvr-floor-plans/'+orphan+'.jpg',jpeg);
    await utimes(root+'/ainvr-floor-plans/'+orphan+'.jpg',stale,stale);
    await images.cleanup(new Set([ref]));
    expect(await readdir(root+'/ainvr-floor-plans')).toContain(ref+'.jpg');
    expect(await readdir(root+'/ainvr-floor-plans')).not.toContain(orphan+'.jpg');
    const deleted=await app.inject({method:'POST',url:'/floor-plans/p1/delete',headers:{...headers,'idempotency-key':'delete-1'},payload:{expected_version:2}});
    expect(deleted.json()).toEqual({deleted:true,id:'p1'});
    expect((await app.inject({url:'/floor-plans/images/'+ref,headers})).statusCode).toBe(404);
    const replayAfterDelete=await save();
    expect(replayAfterDelete.statusCode).toBe(409);
    expect(replayAfterDelete.json()).toMatchObject({error:{code:'operation_superseded'},current:{deleted:true,id:'p1',version:3}});
    const reuse=await app.inject({method:'POST',url:'/floor-plans',headers:{...headers,'idempotency-key':'reuse-deleted'},
      payload:{plan,expected_version:0}});
    expect(reuse.statusCode).toBe(409); expect(reuse.json().error.code).toBe('plan_deleted');
    const staleSave=await app.inject({method:'POST',url:'/floor-plans',headers:{...headers,'idempotency-key':'stale-editor'},
      payload:{plan,expected_version:1}});
    expect(staleSave.statusCode).toBe(409);
    const staleDelete=await app.inject({method:'POST',url:'/floor-plans/p1/delete',headers:{...headers,'idempotency-key':'stale-delete'},payload:{expected_version:1}});
    expect(staleDelete.statusCode).toBe(404);
    expect((await pool.query('SELECT version,deleted_at,document,image FROM floor_plans WHERE id=$1',['p1'])).rows[0])
      .toMatchObject({version:3,document:{},image:null});
    expect((await app.inject({method:'POST',url:'/floor-plans/p1/delete',headers:{...headers,'idempotency-key':'delete-1'},payload:{expected_version:2}})).json()).toEqual(deleted.json());
    // Identity protection must survive pruning the bounded operation ledger.
    await pool.query('DELETE FROM floor_plan_operations');
    const durableReuse=await app.inject({method:'POST',url:'/floor-plans',headers:{...headers,'idempotency-key':'reuse-after-prune'},
      payload:{plan,expected_version:0}});
    expect(durableReuse.statusCode).toBe(409); expect(durableReuse.json().error.code).toBe('plan_deleted');

    for (let i=0;i<20;i++) {
      const response=await app.inject({method:'POST',url:'/floor-plans',headers:{...headers,'idempotency-key':'import-'+i},
        payload:{plan:{...plan,id:'import-'+i,image:null},expected_version:0}});
      expect(response.statusCode,response.body).toBe(200);
    }
    const full=await app.inject({method:'POST',url:'/floor-plans',headers:{...headers,'idempotency-key':'import-20'},
      payload:{plan:{...plan,id:'import-20',image:null},expected_version:0}});
    expect(full.statusCode).toBe(409); expect(full.json().error.code).toBe('plan_capacity');
  } finally {
    await app?.close(); await pool?.end();
    if (created) await admin.query('DROP SCHEMA '+schema+' CASCADE');
    await admin.end();
    if (root && /^\/mnt\/ainvr-ssd\/ainvr-floor-plan-test-[A-Za-z0-9]+$/.test(root)) await rm(root,{recursive:true,force:true});
  }
},30000);
