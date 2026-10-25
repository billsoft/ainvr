import {isIP} from 'node:net';
import {z} from 'zod';

const ip=z.string().refine(v=>isIP(v)===4,'请输入 IPv4 地址');
const port=z.number().int().min(1024).max(65535);
const endpoint=z.string().url().refine(value=>{
  const u=new URL(value);
  return !u.username&&!u.password&&!u.search&&!u.hash&&(u.pathname==='/'||u.pathname==='')&&
    ((u.protocol==='http:'&&['127.0.0.1','[::1]'].includes(u.hostname))||u.protocol==='https:');
},'管理连接须使用本机回环地址或 HTTPS');
export const gbSettingsSchema=z.object({
  enabled:z.boolean(),gatewayUrl:endpoint,
  serverId:z.string().regex(/^\d{20}$/),realm:z.string().regex(/^\d{10}$/),
  listenIp:ip,sipPort:port,advertiseIp:ip,mediaAdvertiseIp:ip,
  mediaPortStart:port,mediaPortEnd:port,capacity:z.number().int().min(1).max(4),
  heartbeatTimeoutSec:z.number().int().min(30).max(3600),
}).strict().superRefine((v,ctx)=>{
  if(v.mediaPortStart%2||v.mediaPortEnd-v.mediaPortStart<2*v.capacity)
    ctx.addIssue({code:'custom',message:'媒体起始端口必须为偶数，范围需覆盖并发容量'});
  if(v.sipPort>=v.mediaPortStart&&v.sipPort<=v.mediaPortEnd)
    ctx.addIssue({code:'custom',message:'信令端口不能占用媒体端口范围'});
});
export type GBSettings=z.infer<typeof gbSettingsSchema>;
export const defaultGBSettings:GBSettings={enabled:false,gatewayUrl:'http://127.0.0.1:8096',
  serverId:'34020000002000000001',realm:'3402000000',listenIp:'0.0.0.0',sipPort:5060,
  advertiseIp:'127.0.0.1',mediaAdvertiseIp:'127.0.0.1',mediaPortStart:30000,mediaPortEnd:30100,
  capacity:4,heartbeatTimeoutSec:180};
export const gbDeviceSchema=z.object({id:z.string().regex(/^\d{20}$/),name:z.string().trim().min(1).max(128),
  version:z.enum(['auto','2016','2022']),enabled:z.boolean(),
  mediaIPs:z.array(ip.refine(v=>{const n=v.split('.').map(Number);return n[0]>0&&n[0]<224&&n[0]!==127&&!(n[0]===169&&n[1]===254);},'媒体地址须为设备的单播 IPv4，不能是本机或链路本地地址')).max(8).default([]),password:z.string().min(8).max(256).optional()}).strict();
