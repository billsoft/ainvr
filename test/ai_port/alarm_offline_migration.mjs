// Called by the deployment coordinator only while backend/alarm publishers are stopped.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFile,writeFile,rename,open} from 'node:fs/promises';
import {captureAlarmRollbackGuard,restoreLegacyAlarmConfiguration} from './alarm_migration_rollback.mjs';
const [mode,backend,guardFile]=process.argv.slice(2);
if(!['prepare','rollback'].includes(mode)||!backend?.startsWith('/')||!guardFile?.startsWith('/'))throw Error('Explicit offline migration arguments required');
const {Pool}=createRequire(backend+'/package.json')('pg');
const pool=new Pool({host:process.env.CONFIG_PG_HOST,port:Number(process.env.CONFIG_PG_PORT||5432),user:process.env.CONFIG_PG_USER,password:process.env.CONFIG_PG_PASSWORD,database:process.env.CONFIG_PG_DATABASE,connectionTimeoutMillis:5000,statement_timeout:15000});
try{
 let result;
 if(mode==='prepare'){
  const {runMigrations}=await import(pathToFileURL(backend+'/dist/store/migrator.js'));
  const {migrateLegacyAlarms}=await import(pathToFileURL(backend+'/dist/store/alarmLegacyMigration.js'));
  const hasRegistry=(await pool.query("SELECT to_regclass('schema_migrations') AS t")).rows[0].t;
  const previousVersion=hasRegistry?Number((await pool.query('SELECT COALESCE(max(version),0)::int AS v FROM schema_migrations')).rows[0].v):0;
  const info=console.info;console.info=()=>{};
  let sql,legacy;
  try{sql=await runMigrations(pool);legacy=await migrateLegacyAlarms(pool);}finally{console.info=info;}
  const guard=await captureAlarmRollbackGuard(pool);
  result={schema_version:1,guard,sql,legacy,migration_changed:(previousVersion<8&&sql.applied>0)||legacy.converted+legacy.review>0,additive_flow_schema:previousVersion>=8&&sql.applied>0};
  const temp=guardFile+'.new';await writeFile(temp,JSON.stringify(result),{flag:'wx',mode:0o600});
  const file=await open(temp,'r');try{await file.sync();}finally{await file.close();}await rename(temp,guardFile);
 }else{
  const saved=JSON.parse(await readFile(guardFile,'utf8'));
  if(saved.schema_version!==1||typeof saved.migration_changed!=='boolean')throw Error('Invalid migration checkpoint');
  result=saved.migration_changed?await restoreLegacyAlarmConfiguration(pool,saved.guard):{unchanged:true};
 }
 console.log(JSON.stringify(result));
}catch{process.stderr.write('Offline alarm migration or guarded recovery failed; keep alarm stopped and inspect private deployment evidence.\n');process.exitCode=1;}
finally{await pool.end();}
