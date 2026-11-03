// Read-only audit after a search model switch: Mongo samples/coverage per model and vector size, PG pin/shards/jobs, SSD shard manifests.
// usage: node deploy-package/audit_search_data.mjs
import fs from "node:fs";
const root="/home/sunrise/ainvr";
const {parseEnv}=await import("node:util");
const env=parseEnv(fs.readFileSync(root+"/deploy/s100p/runtime/backend.env","utf8"));
const {PgConfigStore}=await import(root+"/srs-web-console/backend/dist/store/pgStore.js");
const {MongoClient}=await import(root+"/alarm-service/node_modules/mongodb/lib/index.js");
const pg=new PgConfigStore({poolConfig:{host:env.CONFIG_PG_HOST,port:Number(env.CONFIG_PG_PORT||5432),user:env.CONFIG_PG_USER,password:env.CONFIG_PG_PASSWORD,database:env.CONFIG_PG_DATABASE},masterKeyPath:env.CONFIG_MASTER_KEY_PATH});
const b=JSON.parse(fs.readFileSync(root+"/deploy/s100p/runtime/search-service-bootstrap.json","utf8"));
const rt=await (await fetch(b.control_url+"/api/internal/search/runtime-config",{headers:{"x-service-token":b.service_token}})).json();
const m=new MongoClient(rt.history_connection.uri);await m.connect();const db=m.db(rt.history_connection.database);
console.log("pin",JSON.stringify(rt.active_model_pin));
const s=db.collection("search_samples");
console.log("samples by model/vecbytes",JSON.stringify(await s.aggregate([{$group:{_id:{m:"$model",v:{$binarySize:"$vector"}},n:{$sum:1}}}]).toArray()));
console.log("coverage by model",JSON.stringify(await db.collection("search_coverage").aggregate([{$group:{_id:"$model",n:{$sum:1}}}]).toArray()));
for(const c of ["search_deletions","search_sessions","search_control","search_migration_reports","search_verification_cache"])console.log(c,await db.collection(c).countDocuments());
console.log("pg runtime_state",JSON.stringify((await pg.pool.query("SELECT active_model FROM search_runtime_state")).rows));
console.log("pg shards",(await pg.pool.query("SELECT count(*) FROM search_index_shards")).rows[0].count,"jobs",(await pg.pool.query("SELECT count(*) FROM search_jobs")).rows[0].count);
const idx=rt.index_directory.resolved_path;
for(const d of fs.readdirSync(idx).filter(n=>!n.startsWith("."))){for(const f of fs.readdirSync(idx+"/"+d).filter(f=>f.endsWith(".manifest.json"))){const j=JSON.parse(fs.readFileSync(idx+"/"+d+"/"+f));console.log("shard",d.slice(0,8),f,"dims",j.dimensions,"model",String(j.model_version).slice(0,20))}}
await m.close();await pg.pool.end();
