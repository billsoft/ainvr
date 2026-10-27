// Read-only configuration fingerprints. No credentials or configuration values leave this process.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.resolve(process.argv[2]);
process.loadEnvFile(path.join(root,'deploy/s100p/runtime/backend.env'));
const {default:pg}=await import(pathToFileURL(path.join(root,'srs-web-console/backend/node_modules/pg/lib/index.js')).href);
const client=new pg.Client({host:process.env.CONFIG_PG_HOST,port:Number(process.env.CONFIG_PG_PORT??5432),user:process.env.CONFIG_PG_USER,password:process.env.CONFIG_PG_PASSWORD,database:process.env.CONFIG_PG_DATABASE,connectionTimeoutMillis:3000,statement_timeout:5000});
const tables={config_documents:['created_at','updated_at'],config_secrets:['created_at','updated_at'],alarm_arming_sources:['updated_at'],alarm_monitors:['updated_at'],alarm_trigger_definitions:['updated_at'],alarm_trigger_assignments:['updated_at'],alarm_triggers:['updated_at'],alarm_zones:['updated_at'],flow_counter_definitions:['updated_at'],flow_counter_bindings:['created_at','updated_at'],flow_counters:['updated_at'],gb28181_settings:['updated_at'],gb28181_devices:['updated_at'],gb28181_bindings:[],onvif_settings:['updated_at'],onvif_devices:['capabilities','last_probe_at','last_error','updated_at']};
try{await client.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result={};for(const [table,exclude] of Object.entries(tables)){const query=`SELECT to_jsonb(t)-$1::text[] AS value FROM ${table} t ORDER BY (to_jsonb(t)-$1::text[])::text`;const rows=(await client.query(query,[exclude])).rows.map(r=>r.value);result[table]={count:rows.length,sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')};}await client.query('ROLLBACK');console.log(JSON.stringify(result));}catch{console.error('Cannot verify parameter preservation');process.exitCode=1}finally{await client.end()}
