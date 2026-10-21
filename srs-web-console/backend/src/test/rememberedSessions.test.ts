import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConsoleSessions, RememberedDevices } from '../services/consoleSessions.js';
import { buildTestApp } from './buildTestApp.js';

const DAY=86400_000;
function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'remembered-'));
  let wall=Date.parse('2026-10-20T00:00:00Z');
  const devices=()=>new RememberedDevices(path.join(dir,'remembered-devices.json'),()=>wall);
  return {dir,devices,advance:(ms:number)=>{wall+=ms;},cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
// "Remember this device": the password stays on, but a remembered browser survives
// backend restarts for 30 days. Password change or logout ends it.
it('a remembered device survives a backend restart; an ordinary session does not',()=>{
  const f=fixture();
  try{
    const first=new ConsoleSessions(undefined,undefined,f.devices());
    const remembered=first.create('hash',{remember:true}),ordinary=first.create('hash');
    const restarted=new ConsoleSessions(undefined,undefined,f.devices());
    expect(restarted.get('hash',remembered.token)).toBeTruthy();
    expect(restarted.mediaAllowed('hash',null,`ainvr-media=${remembered.media}`)).toBe(true);
    expect(restarted.get('hash',ordinary.token)).toBeUndefined();
    const stored=fs.readFileSync(path.join(f.dir,'remembered-devices.json'),'utf8');
    expect(stored).not.toContain(remembered.token);expect(stored).not.toContain(remembered.media);expect(stored).not.toContain('"hash"');
    expect(fs.statSync(path.join(f.dir,'remembered-devices.json')).mode&0o077).toBe(0);
  }finally{f.cleanup();}
});
it('remembered devices expire after 30 days and end on password change or logout',()=>{
  const f=fixture();
  try{
    const sessions=new ConsoleSessions(undefined,undefined,f.devices());
    const a=sessions.create('hash',{remember:true}),b=sessions.create('hash',{remember:true});
    f.advance(29*DAY);
    expect(new ConsoleSessions(undefined,undefined,f.devices()).get('hash',a.token)).toBeTruthy();
    f.advance(2*DAY);
    expect(new ConsoleSessions(undefined,undefined,f.devices()).get('hash',a.token)).toBeUndefined();
    const again=new ConsoleSessions(undefined,undefined,f.devices());
    const c=again.create('hash',{remember:true}),d=again.create('hash',{remember:true});
    again.revoke(c.token);
    expect(new ConsoleSessions(undefined,undefined,f.devices()).get('hash',c.token)).toBeUndefined();
    expect(new ConsoleSessions(undefined,undefined,f.devices()).get('changed-password',d.token)).toBeUndefined();
    expect(b).toBeTruthy();
  }finally{f.cleanup();}
});
it('login accepts an explicit remember choice and the device stays signed in after restart',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'remember-login-'));
  try{
    let app=await buildTestApp({dataDir:dir,requireInitialPassword:true});
    await app.inject({method:'PUT',url:'/api/settings/password',payload:{password:'new-password'}});
    const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{password:'new-password',remember:true}});
    expect(login.statusCode).toBe(200);const token=login.json().data.token;
    expect((await app.inject({method:'POST',url:'/api/auth/login',payload:{password:'new-password',remember:'yes'}})).statusCode).toBe(400);
    await app.close();
    app=await buildTestApp({dataDir:dir,requireInitialPassword:true});
    expect((await app.inject({url:'/api/channels',headers:{'x-console-token':token}})).statusCode).not.toBe(401);
    await app.inject({method:'POST',url:'/api/auth/logout',headers:{'x-console-token':token}});
    expect((await app.inject({url:'/api/channels',headers:{'x-console-token':token}})).statusCode).toBe(401);
    await app.close();
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
