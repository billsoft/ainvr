import {z} from 'zod';
import {PullModeAdapter,type ValidateResult} from './adapter.js';
import type {ConfigDocument} from './pgStore.js';
const secret=z.string().refine(v=>/^\$\{secret:llm-service\/[a-zA-Z0-9_.\/-]+\}$/.test(v)||
  (v.length>=32&&v.length<=512&&!v.startsWith('${secret:')),'需要大模型服务专用密钥');
export const llmSettingsSchema=z.object({
  enabled:z.boolean(),listen:z.object({host:z.literal('127.0.0.1'),port:z.literal(8300)}).strict(),
  api_keys:z.array(z.object({name:z.string().regex(/^[a-zA-Z0-9_-]{1,48}$/),scope:z.literal('inference'),key:secret}).strict()).min(1).max(16),
  admin_key:secret,
  model:z.object({package_id:z.literal('qwen3vl-4b-review-v3'),load_policy:z.literal('resident'),ion_reserve_mb:z.literal(512)}).strict(),
  tasks:z.object({'alarm-review-zh-v1':z.object({calibration_temperature:z.number().min(.05).max(10),aspect_policy:z.literal('reject')}).strict()}).strict(),
  scheduling:z.object({queue_size:z.number().int().min(1).max(32),queue_timeout_s:z.number().int().min(1).max(300),
    exec_timeout_s:z.number().int().min(1).max(120),submit_time_share_cap_percent:z.number().int().min(5).max(90),prefill_profile:z.literal('s256')}).strict(),
  logging:z.object({record_requests:z.literal(false)}).strict(),
}).strict().refine(s=>new Set(s.api_keys.map(k=>k.name)).size===s.api_keys.length,'调用方名称不能重复')
  .refine(s=>new Set([s.admin_key,...s.api_keys.map(k=>k.key)]).size===s.api_keys.length+1,'管理密钥和各调用方密钥必须不同');
export class LlmConfigAdapter extends PullModeAdapter {
  constructor(){super('llm-service');}
  override async validate(docs:ConfigDocument[]):Promise<ValidateResult>{
    if(docs.length!==1||docs[0]?.group!=='system'||docs[0]?.name!=='settings')
      return {ok:false,errors:['需要一份大模型服务 system/settings 配置']};
    const parsed=llmSettingsSchema.safeParse(docs[0].config);
    return parsed.success?{ok:true,errors:[]}:{ok:false,errors:['大模型服务配置无效，请检查模型、资源参数和独立调用密钥']};
  }
}
