import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
const require=createRequire(new URL('../srs-web-console/backend/package.json',import.meta.url));
const {Pool}=require('pg');
const {VehiclePreparation}=await import('../srs-web-console/backend/dist/store/vehiclePreparation.js');
const pool=new Pool({host:process.env.CONFIG_PG_HOST,port:Number(process.env.CONFIG_PG_PORT||5432),user:process.env.CONFIG_PG_USER,password:process.env.CONFIG_PG_PASSWORD,database:process.env.CONFIG_PG_DATABASE,max:1});
const client=await pool.connect();
try{
 await client.query('BEGIN');
 await client.query('CREATE SCHEMA vehicle_hardening_test');
 await client.query('SET LOCAL search_path TO vehicle_hardening_test');
 await client.query(await readFile(new URL('../srs-web-console/backend/src/store/migrations/028_vehicle_preparation.sql',import.meta.url),'utf8'));
 const store=new VehiclePreparation({query:(...args)=>client.query(...args)});
 await store.save('watchlist',0,{entries:[{plate:'京A12345',note:''}]},'test');
 await client.query(await readFile(new URL('../srs-web-console/backend/src/store/migrations/029_vehicle_watchlist_versions.sql',import.meta.url),'utf8'));
 assert.equal((await store.watchlistVersion(1)).entries[0].plate,'京A12345');
 await store.save('watchlist',1,{entries:[]},'test');
 assert.equal((await store.watchlistVersion(1)).entries.length,1);
 assert.equal((await store.watchlistVersion(2)).entries.length,0);
 await assert.rejects(store.save('watchlist',1,{entries:[]},'test'),{code:'version_conflict'});
 assert.equal((await client.query('SELECT count(*)::int AS n FROM vehicle_watchlist_versions')).rows[0].n,2);
 console.log('PASS PG migration backfill, immutable history, CAS conflict, transaction rollback');
}finally{await client.query('ROLLBACK');client.release();await pool.end()}
