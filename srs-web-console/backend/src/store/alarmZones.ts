import type {Pool} from 'pg';
import {createHash} from 'node:crypto';
import {z} from 'zod';

const identifier=z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
const point=z.tuple([z.number().finite().min(0).max(1),z.number().finite().min(0).max(1)]);
const zoneSchema=z.object({zone_id:identifier,channel_id:identifier,name:z.string().trim().min(1).max(128),
  geometry_revision:identifier,points:z.array(point).min(3).max(32),state:z.enum(['active','archived'])}).strict();
export type AlarmZoneInput=z.infer<typeof zoneSchema>;
export class AlarmConfigError extends Error {
  constructor(public code:string,message:string,public statusCode=422){super(message);}
}
function validateGeometry(points:[number,number][]){
  const cross=(a:number[],b:number[],c:number[])=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const on=(a:number[],b:number[],p:number[])=>Math.abs(cross(a,b,p))<1e-10&&p[0]>=Math.min(a[0],b[0])-1e-10&&p[0]<=Math.max(a[0],b[0])+1e-10&&p[1]>=Math.min(a[1],b[1])-1e-10&&p[1]<=Math.max(a[1],b[1])+1e-10;
  let area=0;
  for(let i=0;i<points.length;i++){
    const a=points[i],b=points[(i+1)%points.length];
    if(Math.hypot(a[0]-b[0],a[1]-b[1])<1e-8)throw new AlarmConfigError('invalid_geometry','相邻顶点不能重合');
    area+=a[0]*b[1]-b[0]*a[1];
    for(let j=i+1;j<points.length;j++){
      if(j===i+1||(i===0&&j===points.length-1))continue;
      const c=points[j],d=points[(j+1)%points.length];
      if(cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0||on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b))throw new AlarmConfigError('invalid_geometry','区域边界不能相交');
    }
  }
  if(Math.abs(area)<1e-8)throw new AlarmConfigError('invalid_geometry','区域面积不能为零');
}
export class AlarmZoneStore {
  constructor(private pool:Pool){}
  async list(channelId:string){
    if(!identifier.safeParse(channelId).success)throw new AlarmConfigError('invalid_channel','来源通道无效');
    const rows=await this.pool.query('SELECT document, version, updated_at FROM alarm_zones WHERE channel_id=$1 ORDER BY zone_id LIMIT 1001',[channelId]);
    if(rows.rows.length>1000)throw new AlarmConfigError('zone_capacity','区域数量超出列表上限',503);
    return rows.rows.map(r=>({...r.document,version:r.version,updated_at:r.updated_at}));
  }
  async save(input:unknown,expectedVersion:number,actor:string,key:string){
    const parsed=zoneSchema.safeParse(input);
    if(!parsed.success)throw new AlarmConfigError('invalid_zone','警戒区参数无效');
    if(!Number.isInteger(expectedVersion)||expectedVersion<0||expectedVersion>=2147483647)throw new AlarmConfigError('invalid_version','区域版本无效');
    if(!identifier.safeParse(actor).success||!identifier.safeParse(key).success)throw new AlarmConfigError('invalid_operation','操作身份或编号无效');
    const zone=parsed.data;validateGeometry(zone.points);
    const hash=createHash('sha256').update(JSON.stringify([zone,expectedVersion])).digest('hex');
    const client=await this.pool.connect();
    try{
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`alarm-operation:${actor}:${key}`]);
      const previous=await client.query('SELECT request_hash,response FROM alarm_config_operations WHERE actor=$1 AND operation_key=$2',[actor,key]);
      if(previous.rows.length){
        if(previous.rows[0].request_hash!==hash)throw new AlarmConfigError('idempotency_conflict','操作编号已用于其他内容',409);
        await client.query('COMMIT');return previous.rows[0].response;
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`alarm-zone:${zone.zone_id}`]);
      const current=await client.query('SELECT version,channel_id FROM alarm_zones WHERE zone_id=$1 FOR UPDATE',[zone.zone_id]);
      if((current.rows[0]?.version??0)!==expectedVersion)throw new AlarmConfigError('version_conflict','区域已被修改，请重新载入或另存',409);
      if(current.rows[0]&&current.rows[0].channel_id!==zone.channel_id)throw new AlarmConfigError('channel_changed','已有区域不能迁移到其他来源通道',409);
      const version=expectedVersion+1;
      await client.query('INSERT INTO alarm_zones(zone_id,channel_id,version,document) VALUES($1,$2,$3,$4) ON CONFLICT(zone_id) DO UPDATE SET version=EXCLUDED.version,document=EXCLUDED.document,updated_at=now()',[zone.zone_id,zone.channel_id,version,JSON.stringify(zone)]);
      await client.query('INSERT INTO alarm_zone_versions(zone_id,version,document,actor) VALUES($1,$2,$3,$4)',[zone.zone_id,version,JSON.stringify(zone),actor]);
      const response={zone:{...zone,version},saved:true,monitoring_enabled:false};
      await client.query('INSERT INTO alarm_config_operations(actor,operation_key,request_hash,response) VALUES($1,$2,$3,$4)',[actor,key,hash,JSON.stringify(response)]);
      await client.query('COMMIT');return response;
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}
    finally{client.release();}
  }
}
