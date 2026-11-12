// Real PG session-only regression. No persistent writes, credentials from service environment.
import assert from 'node:assert/strict';
import {PgConfigStore} from '../srs-web-console/backend/dist/store/pgStore.js';
const store=new PgConfigStore({masterKeyPath:'/unused-no-encryption-in-this-test',poolConfig:{
 host:process.env.CONFIG_PG_HOST,port:Number(process.env.CONFIG_PG_PORT||5432),
 user:process.env.CONFIG_PG_USER,password:process.env.CONFIG_PG_PASSWORD,database:process.env.CONFIG_PG_DATABASE,
 max:1,idle_in_transaction_session_timeout:500}});
const client=await store.pool.connect();
try{
 await client.query('BEGIN');await client.query('SELECT 1');
 await new Promise(resolve=>setTimeout(resolve,1500));
 await assert.rejects(client.query('SELECT 2'));
}finally{client.release(true);}
try{assert.equal((await store.pool.query('SELECT 1 AS value')).rows[0].value,1);
 console.log('PASS: expired checked-out transaction rejects; process survives; pool replaces client');
}finally{await store.pool.end();}
