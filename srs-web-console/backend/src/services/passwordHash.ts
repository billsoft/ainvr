import crypto from 'node:crypto';
import { promisify } from 'node:util';
const scrypt=promisify(crypto.scrypt);
export const isLegacyHash=(hash:string)=>/^[a-f0-9]{64}$/.test(hash);
export async function protectDigest(digest:string):Promise<string> {
  const salt=crypto.randomBytes(16).toString('hex');
  const key=await scrypt(digest,salt,32) as Buffer;
  return `scrypt-sha256$${salt}$${key.toString('hex')}`;
}
export async function hashPassword(password:string):Promise<string> {
  return protectDigest(crypto.createHash('sha256').update(password).digest('hex'));
}
export async function verifyPassword(password:string,hash:string):Promise<boolean> {
  const digest=crypto.createHash('sha256').update(password).digest('hex');
  if(isLegacyHash(hash))return crypto.timingSafeEqual(Buffer.from(digest),Buffer.from(hash));
  const parts=hash.split('$');
  if(parts.length!==3 || parts[0]!=='scrypt-sha256' || !/^[a-f0-9]{32}$/.test(parts[1]) || !/^[a-f0-9]{64}$/.test(parts[2]))return false;
  return crypto.timingSafeEqual(await scrypt(digest,parts[1],32) as Buffer,Buffer.from(parts[2],'hex'));
}
