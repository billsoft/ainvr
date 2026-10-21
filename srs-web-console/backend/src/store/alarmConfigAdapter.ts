import {PullModeAdapter,type ValidateResult} from './adapter.js';
import type {ConfigDocument} from './pgStore.js';
import {z} from 'zod';
const secret=(name:string)=>z.string().refine(value=>new RegExp('^\\$\\{secret:alarm-service/' + name + '(?:/[a-zA-Z0-9_-]+)?\\}$').test(value)||(value.length>=32&&value.length<=512&&!value.startsWith('${secret:')),'需要本服务专用密钥');
export const alarmSettingsSchema=z.object({
  host:z.enum(['127.0.0.1','::1']),port:z.number().int().min(1024).max(65535),
  database:z.string().regex(/^[a-zA-Z0-9_-]{1,63}$/).refine(v=>!['admin','config','local'].includes(v)),
  mongo_uri:z.string().refine(v=>/^\$\{secret:alarm-service\/mongo_uri(?:\/[a-zA-Z0-9_-]+)?\}$/.test(v)||/^mongodb(?:\+srv)?:\/\//.test(v)),
  api_token:secret('api_token'),producer_token:secret('producer_token'),
  evidence:z.object({enabled:z.boolean(),retention_days:z.number().int().min(1).max(3650),max_bytes:z.number().int().min(128*1024*1024).max(1024**4)}).strict().optional(),
}).strict().refine(v=>v.api_token!==v.producer_token,'管理接口和数据输入必须使用不同密钥');
export class AlarmConfigAdapter extends PullModeAdapter {
  constructor(){super('alarm-service');}
  override async validate(docs:ConfigDocument[]):Promise<ValidateResult>{
    const settings=docs.filter(d=>d.group==='system'&&d.name==='settings');
    if(settings.length!==1||docs.length!==1)return {ok:false,errors:['需要一份告警服务 system/settings 配置']};
    return alarmSettingsSchema.safeParse(settings[0].config).success?{ok:true,errors:[]}:
      {ok:false,errors:['告警服务配置无效：检查监听地址、端口、独立数据库和两种独立密钥']};
  }
}
