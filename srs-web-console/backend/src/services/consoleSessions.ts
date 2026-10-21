import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { MEDIA_COOKIE } from './mediaAuth.js';
type Session = { hash: string; expires: number; media: string };
const digest=(value:string)=>crypto.createHash('sha256').update(value).digest('hex');
type Device = { token: string; media: string; previous_media?: string; password: string; expires: number };
const REMEMBER_MS=30*86400_000, MAX_DEVICES=32;
// "Remember this device": only SHA-256 digests of the token, media secret and
// password record are kept, in a private file, so a remembered browser survives a
// backend restart. Expiry uses wall time (monotonic time does not survive reboot).
// Unreadable or corrupt files remember nothing (fail closed).
export class RememberedDevices {
  private devices: Device[] = [];
  constructor(private file: string, private wall = () => Date.now()) {
    try {
      const data=JSON.parse(fs.readFileSync(file,'utf8'));
      if(data?.schema===1 && Array.isArray(data.devices))
        this.devices=data.devices.filter((d:Device)=>[d.token,d.media,d.password].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))&&(d.previous_media===undefined||/^[a-f0-9]{64}$/.test(d.previous_media))&&Number.isFinite(d.expires));
    } catch { this.devices=[]; }
  }
  private save() {
    const now=this.wall();this.devices=this.devices.filter(d=>d.expires>now);
    fs.mkdirSync(path.dirname(this.file),{recursive:true});
    const temp=`${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp,JSON.stringify({schema:1,devices:this.devices})+'\n',{mode:0o600});
    fs.renameSync(temp,this.file);
  }
  add(token: string, media: string, password: string) {
    const now=this.wall();
    this.devices=this.devices.filter(d=>d.expires>now&&d.password===digest(password));
    while(this.devices.length>=MAX_DEVICES)this.devices.shift();
    this.devices.push({token:digest(token),media:digest(media),password:digest(password),expires:now+REMEMBER_MS});
    this.save();
  }
  /** The device for this secret, if unexpired and bound to the current password. */
  find(secret: string, password: string, field: 'token'|'media' = 'token') {
    const key=digest(secret),device=this.devices.find(d=>field==='token'?d.token===key:d.media===key||d.previous_media===key);
    if(!device)return;
    if(device.expires<=this.wall()||device.password!==digest(password)){this.devices=this.devices.filter(d=>d!==device);this.save();return;}
    return device;
  }
  rotateMedia(token: string, media: string) {
    const device=this.devices.find(d=>d.token===digest(token));
    // The browser's existing media cookie stays valid until the next rotation.
    if(device){device.previous_media=device.media;device.media=digest(media);this.save();}
  }
  remove(token: string) {
    const key=digest(token),before=this.devices.length;
    this.devices=this.devices.filter(d=>d.token!==key);
    if(this.devices.length!==before)this.save();
  }
}
// Restart invalidates ordinary sessions; remembered devices are restored from
// their digests. Password changes invalidate admin, media and remembered devices.
export class ConsoleSessions {
  private sessions = new Map<string, Session>();
  constructor(private now = () => performance.now(), private ttlMs = 12 * 3600_000, private devices?: RememberedDevices) {}
  create(hash: string, {remember=false}: {remember?: boolean} = {}) {
    for (const [key,s] of this.sessions) if(s.expires <= this.now() || s.hash !== hash) this.sessions.delete(key);
    if(this.sessions.size>=256)this.sessions.delete(this.sessions.keys().next().value!);
    const token=crypto.randomBytes(32).toString('hex');
    const media=crypto.randomBytes(32).toString('hex');
    this.sessions.set(token,{hash,media,expires:this.now()+this.ttlMs});
    if(remember)this.devices?.add(token,media,hash);
    return {token,media};
  }
  get(hash: string, token: unknown): Session | undefined {
    if(typeof token!=='string' || token.length!==64)return;
    const s=this.sessions.get(token);
    if(s && s.hash===hash && s.expires>this.now())return s;
    if(s)this.sessions.delete(token);
    if(!this.devices?.find(token,hash))return;
    // Restore a remembered device with a fresh media secret (the old one is only a digest).
    const media=crypto.randomBytes(32).toString('hex');
    const restored={hash,media,expires:this.now()+this.ttlMs};
    this.sessions.set(token,restored);this.devices.rotateMedia(token,media);
    return restored;
  }
  revoke(token: unknown) { if(typeof token==='string'){this.sessions.delete(token);this.devices?.remove(token);} }
  mediaAllowed(hash: string, token: unknown, cookie: unknown) {
    if(this.get(hash,token))return true;
    const media=typeof cookie==='string' ? cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith(MEDIA_COOKIE+'='))?.slice(MEDIA_COOKIE.length+1) : undefined;
    if(!media || media.length!==64)return false;
    for(const [key,s] of this.sessions)if(s.media===media && this.get(hash,key))return true;
    return !!this.devices?.find(media,hash,'media');
  }
}
// Bound password KDF concurrency and attempts; all deadlines are monotonic.
export class LoginAttempts {
  private failures = new Map<string, {count:number; until:number}>();
  private active = 0;
  constructor(private now=()=>performance.now()) {}
  enter(ip:string):boolean {
    const now=this.now();
    for(const [key,b] of this.failures)if(b.until<=now)this.failures.delete(key);
    if(this.active>=2 || (this.failures.get(ip)?.count??0)>=8 || (this.failures.get('*')?.count??0)>=80)return false;
    if(this.failures.size>1024)return false;
    this.active++;return true;
  }
  leave(ip:string,ok:boolean) {
    this.active--;
    if(ok){this.failures.delete(ip);return;}
    for(const key of [ip,'*']) {
      const b=this.failures.get(key)??{count:0,until:this.now()+60_000};
      b.count++;this.failures.set(key,b);
    }
  }
}
