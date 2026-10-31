import type { FastifyInstance, FastifyRequest } from 'fastify';
import { FloorPlanConflict, type FloorPlans } from '../store/floorPlans.js';
import { AlarmConfigError } from '../store/alarmZones.js';

interface Options { store: FloorPlans | null; principal:(req:FastifyRequest)=>Promise<string|null> }
export async function floorPlanRoutes(app:FastifyInstance, options:Options) {
  const actors=new WeakMap<FastifyRequest,string>();
  app.addHook('preHandler',async (req,reply) => {
    const actor=await options.principal(req);
    if (!actor) return reply.code(401).send({ error:{code:'unauthorized',message:'需要登录'} });
    actors.set(req,actor);
    if (!options.store) return reply.code(503).send({ error:{code:'configuration_unavailable',message:'参数库暂不可用'} });
  });
  app.setErrorHandler((error,_req,reply) => {
    if (error instanceof FloorPlanConflict) return reply.code(409).send({error:{code:error.code,message:error.message},current:error.current});
    if (error instanceof AlarmConfigError) return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}});
    if (typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 413) return reply.code(413).send({error:{code:'request_too_large',message:'平面图请求过大'}});
    return reply.code(503).send({error:{code:'floor_plan_unavailable',message:'平面图暂不可用'}});
  });
  app.get('/floor-plans',async () => options.store!.list());
  app.get('/floor-plans/images/:ref',async (req,reply) => {
    const bytes=await options.store!.readImage((req.params as {ref:string}).ref);
    return reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff').type('image/jpeg').send(bytes);
  });
  app.get('/floor-plans/:id',async req => options.store!.get((req.params as {id:string}).id));
  app.post('/floor-plans',{bodyLimit:3*1024*1024},async req => options.store!.save(req.body,actors.get(req)!,req.headers['idempotency-key']));
  app.post('/floor-plans/:id/delete',async req => options.store!.delete((req.params as {id:string}).id,req.body,actors.get(req)!,req.headers['idempotency-key']));
}
