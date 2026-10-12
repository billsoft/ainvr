import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PasswordCache } from '../services/passwordCache.js';
import { mediaCookie } from '../services/mediaAuth.js';
import { ConsoleSessions, LoginAttempts } from '../services/consoleSessions.js';
import { verifyPassword } from '../services/passwordHash.js';
import { clientIdentity } from '../services/proxyIdentity.js';

export interface AuthRoutesOptions {
  passwordCache: PasswordCache;
  sessions: ConsoleSessions;
  requireInitialPassword: boolean;
}
const LoginSchema=z.object({password:z.string().min(1).max(100)});
export async function authRoutes(fastify:FastifyInstance,opts:AuthRoutesOptions) {
  const {passwordCache,sessions,requireInitialPassword}=opts;
  const attempts=new LoginAttempts();
  fastify.post('/auth/media-session',async(req,reply)=>{
    const hash=await passwordCache.get();
    const session=sessions.get(hash,req.headers['x-console-token']);
    if(!session && (hash || requireInitialPassword))return reply.status(401).send({error:'需要登录'});
    reply.header('Set-Cookie',mediaCookie(session?.media??'',clientIdentity(req).protocol==='https'));
    return {code:0};
  });
  fastify.post('/auth/logout',async(req,reply)=>{
    sessions.revoke(req.headers['x-console-token']);
    reply.header('Set-Cookie',mediaCookie(''));
    return {code:0};
  });
  fastify.get('/auth/media-check',async(req,reply)=>{
    const hash=await passwordCache.get();
    const allowed=(!hash && !requireInitialPassword) || sessions.mediaAllowed(hash,req.headers['x-console-token'],req.headers.cookie);
    return reply.status(allowed?204:401).send();
  });
  fastify.get('/auth/status',async(_req,reply)=>{
    const hash=await passwordCache.get();
    return reply.send({code:0,data:{required:!!hash || requireInitialPassword,setupRequired:!hash && requireInitialPassword}});
  });
  fastify.post('/auth/login',async(req,reply)=>{
    const parsed=LoginSchema.safeParse(req.body);
    if(!parsed.success)return reply.status(400).send({error:'参数错误'});
    const ip=clientIdentity(req).ip;
    if(!attempts.enter(ip))return reply.header('Retry-After','60').status(429).send({error:'尝试过于频繁，请一分钟后重试'});
    let ok=false;
    try {
      const hash=await passwordCache.get();
      if(!hash) {
        ok=!requireInitialPassword;
        return ok?{code:0,data:{token:''}}:reply.status(409).send({error:'请先设置管理密码'});
      }
      ok=await verifyPassword(parsed.data.password,hash);
      if(!ok)return reply.status(401).send({error:'密码错误'});
      if(await passwordCache.get()!==hash)return reply.status(401).send({error:'密码已变更，请重试'});
      const session=sessions.create(hash);
      reply.header('Set-Cookie',mediaCookie(session.media,clientIdentity(req).protocol==='https'));
      return {code:0,data:{token:session.token}};
    } finally {attempts.leave(ip,ok);}
  });
}
