import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {GB28181Store,GBError} from '../store/gb28181Store.js';
import {gbSettingsSchema} from '../store/gbSettings.js';
import type {GB28181Sync} from '../services/gb28181Sync.js';

interface Options {store:GB28181Store|null;sync:GB28181Sync|null;principal:(request:FastifyRequest)=>Promise<string|null>}
const revision=z.number().int().min(1);
const id=z.string().regex(/^\d{20}$/);
export async function gb28181Routes(app:FastifyInstance,options:Options){
  const actors=new WeakMap<FastifyRequest,string>();
  app.addHook('preHandler',async(req,reply)=>{
    const actor=await options.principal(req);
    if(!actor)return reply.code(401).send({error:'需要登录'});
    actors.set(req,actor);
    if(!options.store)return reply.code(503).send({error:'国标参数库尚未就绪'});
  });
  app.setErrorHandler((e,_req,reply)=>{
    if(e instanceof z.ZodError)return reply.code(400).send({error:'请求参数无效'});
    return reply.code(e instanceof GBError?e.statusCode:503).send({error:e instanceof GBError?e.message:'国标接入暂不可用，请稍后重试'});
  });
  const store=()=>options.store!;
  app.get('/gb28181/status',async()=>options.sync?.status()??{state:'unavailable'});
  // Source identity is distinct from the internal RTMP bridge protocol.
  app.get('/gb28181/bindings',async()=>{
    const {rows}=await store().pg.pool.query('SELECT input_id,device_id,channel_id,channel_config,(SELECT revision FROM gb28181_settings WHERE singleton) AS revision FROM gb28181_bindings WHERE input_id IS NOT NULL');
    return {items:rows};
  });
  app.get('/gb28181/channel-options',async req=>{
    const {deviceId}=z.object({deviceId:id.optional()}).strict().parse(req.query);
    const client=await store().pg.pool.connect();
    try{
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const revision=Number((await client.query('SELECT revision FROM gb28181_settings WHERE singleton')).rows[0]?.revision);
      const devices=(await client.query('SELECT device_id AS id,name,profile AS version,enabled,media_ips AS "mediaIPs" FROM gb28181_devices ORDER BY name,device_id')).rows;
      const items=deviceId?(await client.query(`SELECT c.channel_id AS id,c.document,c.available,b.input_id,b.enabled,b.transport FROM gb28181_catalog c LEFT JOIN gb28181_bindings b USING(device_id,channel_id) WHERE c.device_id=$1 ORDER BY c.channel_id`,[deviceId])).rows:[];
      await client.query('COMMIT');return {revision,devices,items};
    }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
  });
  app.post('/gb28181/channel-config',async req=>{
    const protocol=z.enum(['flv','hls','webrtc','rtmp','srt']);
    const b=z.object({expectedRevision:revision,deviceId:id,channelId:id,inputId:z.string().uuid().optional(),transport:z.enum(['udp','tcp-passive','tcp-active']),enabled:z.boolean(),
      config:z.object({name:z.string().trim().min(1).max(50),description:z.string().max(1000),protocols:z.array(protocol).min(1).max(5),primary:protocol}).strict()
    }).strict().parse(req.body);
    if(!b.config.protocols.includes(b.config.primary)||new Set(b.config.protocols).size!==b.config.protocols.length)throw new GBError('播放协议设置无效');
    const {expectedRevision,...input}=b;
    return store().saveChannel(input,expectedRevision,actors.get(req)!);
  });
  app.post('/gb28181/channel-configs',async req=>{
    const protocol=z.enum(['flv','hls','webrtc','rtmp','srt']);
    const b=z.object({expectedRevision:revision,channels:z.array(z.object({deviceId:id,channelId:id,transport:z.enum(['udp','tcp-passive','tcp-active']),enabled:z.boolean(),config:z.object({name:z.string().trim().min(1).max(50),description:z.string().max(1000),protocols:z.array(protocol).min(1).max(5),primary:protocol}).strict()}).strict()).min(1).max(100)}).strict().parse(req.body);
    if(b.channels.some(c=>!c.config.protocols.includes(c.config.primary)||new Set(c.config.protocols).size!==c.config.protocols.length))throw new GBError('播放协议设置无效');
    return store().saveChannels(b.channels,b.expectedRevision,actors.get(req)!);
  });
  app.post('/gb28181/devices/:id/bind-channels',async req=>{
    const device=id.parse((req.params as {id:string}).id);
    const b=z.object({channels:z.array(id).min(1).max(100),transport:z.enum(['udp','tcp-passive','tcp-active']),expectedRevision:revision}).strict().parse(req.body);
    return store().bindMany(device,b.channels,b.transport,b.expectedRevision,actors.get(req)!);
  });
  app.post('/gb28181/devices/:id/catalog-refresh',async req=>{
    if(!options.sync)throw new GBError('网关尚未就绪',503);
    await options.sync.refresh(id.parse((req.params as {id:string}).id));
    return {requested:true};
  });
  app.post('/gb28181/devices/:id/channels/:channel/bind',async req=>{
    const params=z.object({id,channel:id}).parse(req.params);
    const b=z.object({transport:z.enum(['udp','tcp-passive','tcp-active']),enabled:z.boolean(),expectedRevision:revision}).strict().parse(req.body);
    return store().bind(params.id,params.channel,b.transport,b.enabled,b.expectedRevision,actors.get(req)!);
  });
  app.get('/gb28181/settings',async()=>store().readSettings());
  app.put('/gb28181/settings',async req=>{
    const b=z.object({settings:gbSettingsSchema,token:z.string().optional(),expectedRevision:revision}).strict().parse(req.body);
    return store().saveSettings(b.settings,b.token,b.expectedRevision,actors.get(req)!);
  });
  app.get('/gb28181/devices',async()=>({items:await store().devices(),revision:(await store().readSettings()).revision}));
  app.post('/gb28181/devices',async req=>{
    const b=z.object({device:z.unknown(),expectedRevision:revision}).strict().parse(req.body);
    return store().saveDevice(b.device,b.expectedRevision,actors.get(req)!);
  });
  app.get('/gb28181/devices/:id/channels',async req=>({items:await store().catalog(id.parse((req.params as {id:string}).id))}));
  app.delete('/gb28181/devices/:id',async req=>{
    const b=z.object({expectedRevision:revision}).strict().parse(req.body);
    return store().removeDevice(id.parse((req.params as {id:string}).id),b.expectedRevision,actors.get(req)!);
  });
}
