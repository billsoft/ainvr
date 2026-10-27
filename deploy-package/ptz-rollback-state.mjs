// Read-only downgrade guard; never initialize/migrate/reset the production database.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve(process.argv[2]??'');
try {
 process.loadEnvFile(path.join(root,'deploy/s100p/runtime/backend.env'));
 const {default:pg}=await import(pathToFileURL(path.join(root,'srs-web-console/backend/node_modules/pg/lib/index.js')).href);
 const client=new pg.Client({host:process.env.CONFIG_PG_HOST,port:Number(process.env.CONFIG_PG_PORT??5432),user:process.env.CONFIG_PG_USER,password:process.env.CONFIG_PG_PASSWORD,database:process.env.CONFIG_PG_DATABASE,connectionTimeoutMillis:3000,statement_timeout:3000});
 await client.connect();
 try {
  await client.query('BEGIN READ ONLY');
  const exists=await client.query("SELECT to_regclass('ptz_view_guards') IS NOT NULL AS present");
  const state=exists.rows[0].present ? (await client.query('SELECT count(*) FILTER(WHERE blocked)::int AS blocked,count(*) FILTER(WHERE stop_pending)::int AS "stopPending" FROM ptz_view_guards')).rows[0] : {blocked:0,stopPending:0};
  await client.query('ROLLBACK');
  process.stdout.write(JSON.stringify(state)+'\n');
 } finally {await client.end();}
} catch {process.stderr.write('Persistent PTZ protection could not be verified.\n');process.exitCode=1;}
