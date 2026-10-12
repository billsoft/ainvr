import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { MEDIA_COOKIE } from './mediaAuth.js';
type Session = { hash: string; expires: number; media: string };
// Restart invalidates sessions. Password changes invalidate admin and media.
export class ConsoleSessions {
  private sessions = new Map<string, Session>();
  constructor(private now = () => performance.now(), private ttlMs = 12 * 3600_000) {}
  create(hash: string) {
    for (const [key,s] of this.sessions) if(s.expires <= this.now() || s.hash !== hash) this.sessions.delete(key);
    if(this.sessions.size>=256)this.sessions.delete(this.sessions.keys().next().value!);
    const token=crypto.randomBytes(32).toString('hex');
    const media=crypto.randomBytes(32).toString('hex');
    this.sessions.set(token,{hash,media,expires:this.now()+this.ttlMs});
    return {token,media};
  }
  get(hash: string, token: unknown): Session | undefined {
    if(typeof token!=='string' || token.length!==64)return;
    const s=this.sessions.get(token);
    if(!s)return;
    if(s.hash!==hash || s.expires<=this.now()){this.sessions.delete(token);return;}
    return s;
  }
  revoke(token: unknown) { if(typeof token==='string')this.sessions.delete(token); }
  mediaAllowed(hash: string, token: unknown, cookie: unknown) {
    if(this.get(hash,token))return true;
    const media=typeof cookie==='string' ? cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith(MEDIA_COOKIE+'='))?.slice(MEDIA_COOKIE.length+1) : undefined;
    if(!media || media.length!==64)return false;
    for(const [key,s] of this.sessions)if(s.media===media && this.get(hash,key))return true;
    return false;
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
