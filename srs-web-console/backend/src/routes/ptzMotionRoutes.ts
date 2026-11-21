import type {FastifyInstance,FastifyRequest} from 'fastify';
import {motionRequest,type PtzMotionAdmission} from '../services/ptzMotionAdmission.js';
export async function ptzMotionRoutes(app:FastifyInstance,options:{admission:PtzMotionAdmission|null;principal:(req:FastifyRequest)=>boolean}){
 app.post('/api/internal/ptz-motion/admit',{bodyLimit:8192},async(req,reply)=>{
  if(!options.principal(req)||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.ip))
   return reply.code(403).send({error:'Service identity required'});
  const body=motionRequest.safeParse(req.body);
  if(!body.success)return reply.code(422).send({error:'Invalid motion admission'});
  if(!options.admission)return reply.code(503).send({error:'Motion protection unavailable'});
  try{return reply.header('Cache-Control','no-store').send(await options.admission.admit(body.data));}
  catch{return reply.code(503).send({error:'Motion protection temporarily unavailable'});}
 });
}
