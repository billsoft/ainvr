import type {Pool} from 'pg';
import {z} from 'zod';
import {AlarmConfigError} from './alarmZones.js';

// Runtime availability is reported separately from persisted configuration.
export const vehicleCapability = {
 state:'unavailable',effective:false,reason:'车牌运行服务暂不可用，已保存配置保留',blockers:['runtime_unavailable'],
} as const;
const plate=z.string().trim().transform(v=>v.toUpperCase().replace(/\s/g,''))
  .pipe(z.string().regex(/^[京沪津渝冀晋蒙辽吉黑苏浙皖闽赣鲁豫鄂湘粤桂琼川贵云藏陕甘青宁新][A-Z](?:[A-Z0-9]{5,6}|[A-Z0-9]{4}[挂学警港澳])$/));
export const watchlistSchema=z.object({entries:z.array(z.object({plate,note:z.string().trim().max(120)}).strict()).max(500)})
  .strict().refine(v=>new Set(v.entries.map(e=>e.plate)).size===v.entries.length,'车牌重复');
export const channelPreparationSchema=z.object({requested:z.boolean()}).strict();
export const savePreparationSchema=z.object({expected_version:z.number().int().min(0).max(2147483646),document:z.unknown()}).strict();
export function vehicleOnly(labels:unknown):boolean {
  const vehicleNames=new Set(['car','bus','truck','motorcycle','bicycle']);
  return Array.isArray(labels)&&labels.length>0&&labels.every(l=>typeof l?.name==='string'&&vehicleNames.has(l.name.toLowerCase()));
}
export interface PreparationDocument {version:number;document:unknown;updated_at?:Date;updated_by?:string}
export interface PreparationStore {read(key:string):Promise<PreparationDocument>;save(key:string,version:number,document:unknown,actor:string):Promise<PreparationDocument>}
export class VehiclePreparation implements PreparationStore {
  constructor(private readonly pool:Pool){}
  async watchlistVersion(version:number):Promise<{version:number;entries:{plate:string}[]}>{
    if(!Number.isSafeInteger(version)||version<0)throw new AlarmConfigError('invalid_version','名单版本无效');
    if(version===0)return {version:0,entries:[]};
    const {rows}=await this.pool.query('SELECT document FROM vehicle_watchlist_versions WHERE version=$1',[version]);
    if(!rows[0])throw new AlarmConfigError('watchlist_version_missing','名单版本暂不可用',503);
    return {version,entries:watchlistSchema.parse(rows[0].document).entries.map(({plate})=>({plate}))};
  }
  async requestedChannels():Promise<string[]>{
    const {rows}=await this.pool.query("SELECT id FROM vehicle_preparation WHERE id LIKE 'channel:%' AND document->>'requested'='true' ORDER BY id LIMIT 33");
    if(rows.length>32)throw new AlarmConfigError('vehicle_channel_capacity','最多启用32个车辆通道',409);
    return rows.map(r=>r.id.slice(8));
  }
  async read(key:string):Promise<PreparationDocument>{
    const {rows}=await this.pool.query('SELECT version,document,updated_at,updated_by FROM vehicle_preparation WHERE id=$1',[key]);
    return rows[0]??{version:0,document:key==='watchlist'?{entries:[]}:{requested:false}};
  }
  async save(key:string,version:number,document:unknown,actor:string):Promise<PreparationDocument>{
    // One conditional SQL statement serializes simultaneous creates and updates.
    const {rows}=await this.pool.query(`INSERT INTO vehicle_preparation(id,version,document,updated_by)
      SELECT $1,1,$3::jsonb,$4 WHERE $2::integer=0
      ON CONFLICT(id) DO NOTHING RETURNING version,document,updated_at,updated_by`,[key,version,JSON.stringify(document),actor]);
    if(rows[0])return rows[0];
    if(version>0){
      const result=await this.pool.query(`UPDATE vehicle_preparation SET version=version+1,document=$3::jsonb,updated_by=$4,updated_at=now()
        WHERE id=$1 AND version=$2 RETURNING version,document,updated_at,updated_by`,[key,version,JSON.stringify(document),actor]);
      if(result.rows[0])return result.rows[0];
    }
    throw new AlarmConfigError('version_conflict','配置已变化，请重新载入后保存',409);
  }
}
