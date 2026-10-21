import {it,expect} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {AlarmZoneStore} from '../store/alarmZones.js';
const enabled=process.env.AINVR_ALARM_TEST_PG==='1';
it.skipIf(!enabled)('real isolated PG: atomic zone versions, concurrent edits, idempotency and preserved archive history',async()=>{
  // Dedicated disposable instance only; never read production credentials.
  const connection={host:'127.0.0.1',port:25439,user:'alarm_test',database:'alarm_test'};
  const schema='zones_'+randomUUID().replaceAll('-','');
  const admin=new Pool(connection);await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({...connection,options:`-c search_path=${schema}`});
  try{
    await pool.query(readFileSync(new URL('../store/migrations/003_alarm_zones.sql',import.meta.url),'utf8'));
    const store=new AlarmZoneStore(pool),zone={zone_id:'z',channel_id:'c',name:'大门',geometry_revision:'g1',points:[[.1,.1],[.8,.1],[.8,.8],[.1,.8]],state:'active'};
    const first=await store.save(zone,0,'operator','one');expect(first.zone.version).toBe(1);expect(first.monitoring_enabled).toBe(false);
    expect(await store.save(zone,0,'operator','one')).toEqual(first);
    const outcomes=await Promise.allSettled([store.save({...zone,name:'A'},1,'operator','two'),store.save({...zone,name:'B'},1,'operator','three')]);
    expect(outcomes.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(x=>x.status==='rejected')).toHaveLength(1);
    expect((await store.list('c'))[0].version).toBe(2);
    await expect(store.save({...zone,channel_id:'other'},2,'operator','move')).rejects.toMatchObject({code:'channel_changed'});
    await expect(store.save({...zone,name:'changed'},0,'operator','one')).rejects.toMatchObject({code:'idempotency_conflict'});
    await expect(store.save({...zone,points:[[0,0],[1,1],[0,1],[1,0]]},2,'operator','invalid')).rejects.toMatchObject({code:'invalid_geometry'});
    await store.save({...zone,state:'archived'},2,'operator','archive');
    expect((await pool.query('SELECT count(*)::int AS n FROM alarm_zone_versions')).rows[0].n).toBe(3);
    expect((await store.list('c'))[0].state).toBe('archived');
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
