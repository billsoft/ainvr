// Bounded, restartable migration. Default is read-only. Legacy files are never deleted.
import {MongoClient} from 'mongodb';
import {resolve} from 'node:path';
import {loadBootstrap,createConfigTransport} from './config-center.mjs';
import {validateConfig} from './runtime.mjs';
import {EvidenceImages} from './evidence-images.mjs';
import {EvidenceVault} from './evidence-vault.mjs';
import {ReviewContext} from './review-context.mjs';
import {AlarmRepository} from './repository.mjs';
const [bootstrapPath,mode]=process.argv.slice(2);
if(!bootstrapPath||!['--inspect','--apply'].includes(mode))throw Error('Usage: migrate-evidence-images.mjs BOOTSTRAP --inspect|--apply');
const request=createConfigTransport(await loadBootstrap(bootstrapPath));
const state=await request('service-states/alarm-service');
const docs=await request(`versions/${state.appliedVersion}/snapshot?service=alarm-service`);
const config=validateConfig({...docs[0].config,schema_version:'1.0',version:state.appliedVersion,operation_id:'evidence-migration'});
const client=new MongoClient(config.mongo_uri,{serverSelectionTimeoutMS:3000,socketTimeoutMS:10000,maxPoolSize:2});
const report={mode,crop_variants_migrated:0,context_images_migrated:0,unavailable:0,legacy_files_deleted:0};
try{
 await client.connect();const db=client.db(config.database),images=new EvidenceImages(db);
 const vault=new EvidenceVault(db,{root:resolve(process.env.AINVR_ALARM_EVIDENCE_ROOT??'/mnt/ainvr-ssd/ainvr-alarm-evidence',config.database),policy:config.evidence,images});
 const context=new ReviewContext(new AlarmRepository(db),process.env.AINVR_REVIEW_FRAME_ROOT??'/mnt/ainvr-ssd/ainvr-review-frames');context.policy=config.review;
 const filter={state:'stored',files:{$elemMatch:{storage:{$ne:'mongodb'}}}};
 report.legacy_crop_records=await vault.rows.countDocuments(filter);
 const legacyFields=['frames','prepared_frames','context_frames'];
 const legacyQuery={$or:legacyFields.map(field=>({[`review.${field}`]:{$elemMatch:{storage:{$ne:'mongodb'}}}}))};
 report.legacy_context_records=await context.repository.events.countDocuments(legacyQuery);
 if(mode==='--apply'){
  await images.initialize();
  for await(const row of vault.rows.find(filter).sort({occurred_at:-1}).limit(1000))for(const f of row.files??[])if(f.storage!=='mongodb'){
   try{await vault.image(row._id,f.variant);report.crop_variants_migrated++;}catch{report.unavailable++;}
  }
  for await(const row of context.repository.events.find(legacyQuery).sort({occurred_at:-1}).limit(1000)){
   const keys=[...new Set(legacyFields.flatMap(field=>row.review?.[field]??[]).filter(f=>f.storage!=='mongodb').map(f=>f.key))];
   for(const key of keys)try{await context.retained(row.alarm_id,key);report.context_images_migrated++;}catch{report.unavailable++;}
  }
 }
 console.log(JSON.stringify(report));
}finally{await client.close();}
