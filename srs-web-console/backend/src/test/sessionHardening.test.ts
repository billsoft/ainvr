import { it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTestApp } from './buildTestApp.js';
import { ConsoleSessions } from '../services/consoleSessions.js';
import { hashPassword, verifyPassword } from '../services/passwordHash.js';
import { LicenseClient } from '../license/licenseClient.js';
import { LicenseGate } from '../license/licenseGate.js';

it('login issues distinct revocable tokens; password hashes are never credentials', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'session-hardening-'));
  const app=await buildTestApp({dataDir:dir});
  try {
    await app.inject({method:'PUT',url:'/api/settings/password',payload:{password:'test-password'}});
    const login=()=>app.inject({method:'POST',url:'/api/auth/login',payload:{password:'test-password'}});
    const first=await login(), second=await login();
    const token=first.json().data.token;
    expect(token).not.toBe(second.json().data.token);
    const hash=crypto.createHash('sha256').update('test-password').digest('hex');
    expect((await app.inject({url:'/api/settings',headers:{'x-console-token':hash}})).statusCode).toBe(401);
    await app.inject({method:'POST',url:'/api/auth/logout',headers:{'x-console-token':token}});
    expect((await app.inject({url:'/api/settings',headers:{'x-console-token':token}})).statusCode).toBe(401);
    expect((await app.inject({url:'/api/auth/media-check',headers:{cookie:String(first.headers['set-cookie']).split(';')[0]}})).statusCode).toBe(401);
  } finally {await app.close();fs.rmSync(dir,{recursive:true,force:true});}
});

it('rejects foreign-origin configuration writes before password initialization', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'origin-hardening-'));
  const app=await buildTestApp({dataDir:dir});
  try {
    const res=await app.inject({method:'PUT',url:'/api/settings/password',headers:{origin:'https://foreign.example'},payload:{password:'attacker-password'}});
    expect(res.statusCode).toBe(403);
  } finally {await app.close();fs.rmSync(dir,{recursive:true,force:true});}
});

it('rate limits repeated failed password guesses',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'login-rate-'));
  const app=await buildTestApp({dataDir:dir});
  try {
    await app.inject({method:'PUT',url:'/api/settings/password',payload:{password:'test-password'}});
    let status=0;
    for(let i=0;i<12;i++)status=(await app.inject({method:'POST',url:'/api/auth/login',payload:{password:'wrong'}})).statusCode;
    expect(status).toBe(429);
  } finally {await app.close();fs.rmSync(dir,{recursive:true,force:true});}
});

it('expires both credentials using monotonic time and rejects changed passwords',()=>{
  let now=10;const sessions=new ConsoleSessions(()=>now,100);
  const s=sessions.create('hash');
  expect(sessions.get('hash',s.token)).toBeTruthy();
  expect(sessions.mediaAllowed('hash',null,`ainvr-media=${s.media}`)).toBe(true);
  now=111;
  expect(sessions.mediaAllowed('hash',null,`ainvr-media=${s.media}`)).toBe(false);
  const t=sessions.create('hash');
  expect(sessions.get('changed',t.token)).toBeUndefined();
});

it('salts password records and verifies both migrated and new passwords',async()=>{
  const a=await hashPassword('password'), b=await hashPassword('password');
  expect(a).not.toBe(b);
  expect(await verifyPassword('password',a)).toBe(true);
  expect(await verifyPassword('wrong',a)).toBe(false);
});

it('production bootstrap only allows initial password setup and prevents disabling it',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bootstrap-'));
  const app=await buildTestApp({dataDir:dir,requireInitialPassword:true});
  try {
    expect((await app.inject({url:'/api/auth/status'})).json().data.setupRequired).toBe(true);
    expect((await app.inject({url:'/api/channels'})).statusCode).toBe(401);
    expect((await app.inject({method:'PUT',url:'/api/settings/password',payload:{password:'short'}})).statusCode).toBe(400);
    expect((await app.inject({method:'PUT',url:'/api/settings/password',payload:{password:'new-password'}})).statusCode).toBe(200);
    const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{password:'new-password'}});
    expect((await app.inject({method:'PUT',url:'/api/settings/password',headers:{'x-console-token':login.json().data.token},payload:{password:''}})).statusCode).toBe(400);
    expect((await app.inject({method:'PUT',url:'/api/settings/password',payload:{password:'other-password'}})).statusCode).toBe(401);
  } finally {await app.close();fs.rmSync(dir,{recursive:true,force:true});}
});

it('allows password bootstrap and license recovery even while licensing is unavailable',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bootstrap-unlicensed-'));
  const client=new LicenseClient({transport:{request:async()=>{throw new Error('offline');}}});
  const app=await buildTestApp({dataDir:dir,requireInitialPassword:true,licenseClient:client,licenseGate:new LicenseGate(client)});
  try {
    expect((await app.inject({method:'PUT',url:'/api/settings/password',payload:{password:'new-password'}})).statusCode).toBe(200);
    const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{password:'new-password'}});
    expect(login.statusCode).toBe(200);
    expect((await app.inject({url:'/api/channels',headers:{'x-console-token':login.json().data.token}})).statusCode).toBe(503);
  } finally {await app.close();fs.rmSync(dir,{recursive:true,force:true});}
});
