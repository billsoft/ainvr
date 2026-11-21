// Read-only downgrade guard; never initialize/migrate/reset the production database.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export async function readRollbackState(client) {
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try {
  const exists=await client.query("SELECT to_regclass('ptz_view_guards') IS NOT NULL AS guards, to_regclass('arming_scene_zones') IS NOT NULL AS scenes");
  const present=exists.rows[0];
  const state=present.guards ? (await client.query('SELECT count(*) FILTER(WHERE blocked)::int AS blocked,count(*) FILTER(WHERE stop_pending)::int AS "stopPending" FROM ptz_view_guards')).rows[0] : {blocked:0,stopPending:0};
  const sceneBindings=present.scenes ? (await client.query('SELECT count(*)::int AS "sceneBindings" FROM arming_scene_zones')).rows[0].sceneBindings : 0;
  const hasMode=present.scenes&&(await client.query("SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('arming_scene_zones') AND attname='binding_mode' AND NOT attisdropped) AS mode")).rows[0].mode;
  const presetBindings=hasMode?(await client.query("SELECT count(*)::int AS \"presetBindings\" FROM arming_scene_zones WHERE binding_mode='preset'")).rows[0].presetBindings:0;
  return {...state,sceneBindings,presetBindings};
 } finally {await client.query('ROLLBACK');}
}
async function main() {
 const root=path.resolve(process.argv[2]??'');
 try {
 process.loadEnvFile(path.join(root,'deploy/s100p/runtime/backend.env'));
 const {default:pg}=await import(pathToFileURL(path.join(root,'srs-web-console/backend/node_modules/pg/lib/index.js')).href);
 const client=new pg.Client({host:process.env.CONFIG_PG_HOST,port:Number(process.env.CONFIG_PG_PORT??5432),user:process.env.CONFIG_PG_USER,password:process.env.CONFIG_PG_PASSWORD,database:process.env.CONFIG_PG_DATABASE,connectionTimeoutMillis:3000,statement_timeout:3000});
 await client.connect();
 try {
  const state=await readRollbackState(client);
  process.stdout.write(JSON.stringify(state)+'\n');
 } finally {await client.end();}
} catch {process.stderr.write('Persistent PTZ protection could not be verified.\n');process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
