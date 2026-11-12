import type {VehicleRuntime} from '../services/vehicleRuntime.js';
import {createVehicleArtifactReader} from '../services/vehicleArtifacts.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {AlarmArmingStore} from '../store/alarmArmingStore.js';
import {AlarmConfigError} from '../store/alarmZones.js';
import {vehicleCapability,vehicleOnly,watchlistSchema,channelPreparationSchema,savePreparationSchema,type PreparationStore} from '../store/vehiclePreparation.js';

interface Options {store:PreparationStore|null;arming:AlarmArmingStore|null;principal:(r:FastifyRequest)=>Promise<string|null>;channelExists:(id:string)=>Promise<boolean>;runtime?:VehicleRuntime|null;internalPrincipal?:(r:FastifyRequest)=>Promise<boolean>}
export async function vehicleRoutes(app:FastifyInstance,options:Options){
  const artifacts=createVehicleArtifactReader();
  const capability=async()=>options.runtime?options.runtime.capability():({...vehicleCapability,artifacts:await artifacts()});
  const channelCapability=async(id:string)=>{const c:any=await capability(),source=c.source_states?.[id],configured=c.runtime?.configured_channels?.includes(id);return {...c,effective:!!c.effective&&!!configured,reason:configured?c.reason:source?.state==='unsupported'?'当前视频尺寸不支持车牌识别':source?.state==='awaiting_video'?'配置已保存，等待视频核验':'当前通道尚未启用车牌识别'};};
  const actors=new WeakMap<FastifyRequest,string>();
  app.addHook('preHandler',async(req,reply)=>{if((req.url.split('?')[0]==='/api/internal/vehicle-recognize'||/^\/api\/internal\/vehicle-watchlist\/\d+$/.test(req.url))&&await options.internalPrincipal?.(req))return;const actor=await options.principal(req);if(!actor)return reply.code(401).send({error:{code:'unauthorized',message:'需要登录'}});actors.set(req,actor);});
  app.setErrorHandler((e,_req,reply)=>reply.code(e instanceof AlarmConfigError?e.statusCode:503).send({error:{code:e instanceof AlarmConfigError?e.code:'vehicle_unavailable',message:e instanceof AlarmConfigError?e.message:'车辆配置暂不可用，请重试'}}));
  const store=()=>{if(!options.store)throw new AlarmConfigError('configuration_unavailable','参数库暂不可用',503);return options.store;};
  app.post('/internal/vehicle-recognize',{bodyLimit:12*1024*1024},async req=>{
    if(!options.runtime||!await options.internalPrincipal?.(req))throw new AlarmConfigError('forbidden','内部识别接口禁止直接调用',403);
    const b=req.body as {meta:unknown;jpeg:string};if(!b||typeof b.jpeg!=='string'||b.jpeg.length>12*1024*1024)throw new AlarmConfigError('invalid_image','图像无效');
    return options.runtime.recognize(b.meta,Buffer.from(b.jpeg,'base64'));
  });
  app.get('/internal/vehicle-watchlist/:version',async req=>{if(!options.runtime||!await options.internalPrincipal?.(req))throw new AlarmConfigError('forbidden','内部接口禁止直接调用',403);return options.runtime.watchlist(Number((req.params as {version:string}).version));});
  const eventId=(req:FastifyRequest)=>{const id=(req.params as {id:string}).id;if(!/^[a-f0-9]{64}$/.test(id))throw new AlarmConfigError('invalid_event','通行编号无效');return id;};
  app.get('/vehicle/records/:id',async(req,reply)=>{if(!options.runtime)throw Error();const r=await options.runtime.alarmFetch('/v1/vehicles/'+eventId(req));return reply.type(r.type).send(r.bytes);});
  app.get('/vehicle/records/:id/images/:key',async(req,reply)=>{if(!options.runtime)throw Error();const key=(req.params as {key:string}).key;if(!/^[a-f0-9]{64}$/.test(key))throw new AlarmConfigError('invalid_image','图像编号无效');const r=await options.runtime.alarmFetch('/v1/vehicles/'+eventId(req)+'/images/'+key);return reply.header('Cache-Control','private, no-store').type(r.type).send(r.bytes);});
  app.put('/vehicle/records/:id/correction',{bodyLimit:4096},async(req,reply)=>{if(!options.runtime)throw Error();const r=await options.runtime.alarmFetch('/v1/vehicles/'+eventId(req)+'/correction','PUT',req.body,actors.get(req));return reply.type(r.type).send(r.bytes);});
  app.post('/vehicle/records/:id/retry',async(req,reply)=>{if(!options.runtime)throw Error();const r=await options.runtime.alarmFetch('/v1/vehicles/'+eventId(req)+'/retry','POST',{},actors.get(req));return reply.type(r.type).send(r.bytes);});
  app.get('/vehicle/capabilities' ,async()=>capability());
  app.get('/vehicle/counters',async()=>{
    if(!options.arming)throw new AlarmConfigError('configuration_unavailable','参数库暂不可用',503);
    const all=await options.arming.listCounters(true);
    const candidates=all.filter(c=>vehicleOnly(c.labels)&&!c.deleting);
    const history=await options.arming.definitionHistory(candidates.map(c=>c.counter_id));
    // Do not relabel old people counts as vehicles after changing current labels.
    const items=candidates.filter(c=>{
      const versions=history.filter(h=>h.counter_id===c.counter_id),ids=new Set(c.labels.map((l:{label_id:string})=>l.label_id));
      return versions.length>0&&versions.every(h=>h.labels.length>0&&h.labels.every(l=>ids.has(l.label_id)));
    });
    return {items,excluded:all.length-items.length,policy:'vehicle_labels_with_compatible_history',capability:await capability()};
  });
  async function channel(req:FastifyRequest){
    const id=(req.params as {id:string}).id;
    if(!/^[a-zA-Z0-9_.:-]{1,128}$/.test(id))throw new AlarmConfigError('invalid_channel','通道编号无效');
    if(!await options.channelExists(id))throw new AlarmConfigError('channel_not_found','AI 通道不存在或暂不可用，请刷新',404);
    return 'channel:'+id;
  }
  app.get('/vehicle/channels/:id',async req=>{const stored=await store().read(await channel(req)),id=(req.params as {id:string}).id,wanted=await options.runtime?.configured(id);return {...stored,...(wanted!==null&&wanted!==undefined?{document:{requested:wanted}}:{}),capability:await channelCapability(id)};});
  app.put('/vehicle/channels/:id',{bodyLimit:4096},async req=>{
    const key=await channel(req),p=savePreparationSchema.safeParse(req.body);
    if(await options.runtime?.configured(key.slice(8))!==null&&options.runtime)throw new AlarmConfigError('use_channel_models','请在 AI 通道的模型与推理中添加或移除车牌识别模型',409);
    const document=channelPreparationSchema.safeParse(p.success?p.data.document:null);
    if(!p.success||!document.success)throw new AlarmConfigError('invalid_request','车辆能力参数无效');
    if(document.data.requested)await options.runtime?.preflight(key.slice(8));
    const saved=await store().save(key,p.data.expected_version,document.data,actors.get(req)!);await options.runtime?.sync();return {...saved,capability:await channelCapability(key.slice(8))};
  });
  app.get('/vehicle/watchlist',async()=>({...await store().read('watchlist'),capability:await capability()}));
  app.put('/vehicle/watchlist',{bodyLimit:128*1024},async req=>{
    const p=savePreparationSchema.safeParse(req.body),document=watchlistSchema.safeParse(p.success?p.data.document:null);
    if(!p.success||!document.success)throw new AlarmConfigError('invalid_request','请输入不重复的普通、新能源或支持的挂/学/警/港/澳车牌（最多500条），备注不超过120字');
    const saved=await store().save('watchlist',p.data.expected_version,document.data,actors.get(req)!);await options.runtime?.sync();return {...saved,capability:await capability()};
  });
}
