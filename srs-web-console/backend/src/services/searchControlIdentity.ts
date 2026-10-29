import {createHash} from 'node:crypto';
/** Shared deterministic UUIDv8 for idempotent PG control requests, not evidence
 * identity or authentication. The domain is fixed by each first-party caller. */
export function searchControlRequestId(domain:string,identity:readonly unknown[]) {
  const hex=createHash('sha256').update(JSON.stringify([domain,identity]),'utf8').digest('hex').slice(0,32).split('');
  hex[12]='8';hex[16]='89ab'[Number.parseInt(hex[16]!,16)&3]!;
  const value=hex.join('');return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
}
