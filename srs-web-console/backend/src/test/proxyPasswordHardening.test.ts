import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTestApp } from './buildTestApp.js';

async function fixture() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'proxy-password-'));
  const app=await buildTestApp({dataDir:dir, trustedProxyLookup:async()=>['172.19.0.3']} as any);
  await app.inject({method:'PUT',url:'/api/settings/password',payload:{password:'initial-password'}});
  return {app,close:async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});}};
}

it('failed guesses behind nginx do not lock out a different client',async()=>{
  const {app,close}=await fixture();
  try {
    for(let i=0;i<8;i++)await app.inject({method:'POST',url:'/api/auth/login',remoteAddress:'172.19.0.3',
      headers:{'x-real-ip':'192.168.100.10'},payload:{password:'wrong'}});
    const good=await app.inject({method:'POST',url:'/api/auth/login',remoteAddress:'172.19.0.3',
      headers:{'x-real-ip':'192.168.100.20'},payload:{password:'initial-password'}});
    expect(good.statusCode).toBe(200);
  } finally {await close();}
});

it('untrusted peers cannot evade limits using forged proxy headers',async()=>{
  const {app,close}=await fixture();
  try {
    for(let i=0;i<8;i++)await app.inject({method:'POST',url:'/api/auth/login',remoteAddress:'192.168.100.10',
      headers:{'x-real-ip':`10.0.0.${i+1}`},payload:{password:'wrong'}});
    expect((await app.inject({method:'POST',url:'/api/auth/login',remoteAddress:'192.168.100.10',
      headers:{'x-real-ip':'10.0.0.99'},payload:{password:'initial-password'}})).statusCode).toBe(429);
  } finally {await close();}
});

it('requires the old password and invalidates old sessions after a change',async()=>{
  const {app,close}=await fixture();
  try {
    const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{password:'initial-password'}});
    const headers={'x-console-token':login.json().data.token};
    for(const oldPassword of [undefined,'wrong']) {
      expect((await app.inject({method:'PUT',url:'/api/settings/password',headers,
        payload:{password:'replacement-password',oldPassword}})).statusCode).toBe(403);
    }
    expect((await app.inject({method:'PUT',url:'/api/settings/password',headers,
      payload:{password:'replacement-password',oldPassword:'initial-password'}})).statusCode).toBe(200);
    expect((await app.inject({url:'/api/settings',headers})).statusCode).toBe(401);
  } finally {await close();}
});

it('only a trusted proxy may attest HTTPS for origin checks and secure cookies',async()=>{
  const {app,close}=await fixture();
  const headers={host:'nvr.example',origin:'https://nvr.example','x-forwarded-proto':'https','x-real-ip':'192.168.100.20'};
  try {
    const req={method:'POST' as const,url:'/api/auth/login',headers,payload:{password:'initial-password'}};
    expect((await app.inject({...req,remoteAddress:'192.168.100.10'})).statusCode).toBe(403);
    const trusted=await app.inject({...req,remoteAddress:'172.19.0.3'});
    expect(trusted.statusCode).toBe(200);
    expect(trusted.headers['set-cookie']).toContain('Secure');
  } finally {await close();}
});
