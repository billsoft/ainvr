import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../srs-web-console/backend/package.json',import.meta.url));
const {Pool}=require('pg');
const {VehiclePreparation}=await import('../srs-web-console/backend/dist/store/vehiclePreparation.js');
const pool=new Pool({host:process.env.CONFIG_PG_HOST,port:Number(process.env.CONFIG_PG_PORT||5432),user:process.env.CONFIG_PG_USER,password:process.env.CONFIG_PG_PASSWORD,database:process.env.CONFIG_PG_DATABASE,max:1});
const client=await pool.connect();
try{
 await client.query('BEGIN');
 await client.query('CREATE TEMP TABLE vehicle_preparation(id text PRIMARY KEY,version integer NOT NULL,document jsonb NOT NULL,updated_by text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now()) ON COMMIT DROP');
 const store=new VehiclePreparation({query:(...args)=>client.query(...args)});
 assert.equal((await store.read('watchlist')).version,0);
 const one=await store.save('watchlist',0,{entries:[{plate:'京A12345',note:'isolated temporary test'}]},'test');assert.equal(one.version,1);
 await assert.rejects(store.save('watchlist',0,{entries:[]},'test'),{code:'version_conflict'});
 const results=await Promise.allSettled([store.save('watchlist',1,{entries:[]},'a'),store.save('watchlist',1,{entries:[]},'b')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await store.read('watchlist')).version,2);
 console.log('PASS real PostgreSQL: isolated temporary table, create/read/conflict/concurrent version checks; transaction rolled back');
}finally{await client.query('ROLLBACK');client.release();await pool.end()}
