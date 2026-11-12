import {request,requestBlob} from './httpClient'
import type {Counter} from './flowService'
export interface VehicleCapability {state:'pending_model_integration'|'available'|'unavailable';effective:boolean;queue?:{pending:number;failed:number;oldest_wait_ms:number;last_inference_ms?:number|null;last_delivery_ms?:number|null;last_failure?:{code:string;phase:string;at:string}|null}|null;reason:string;blockers:string[];artifacts?:{file:string;state:'verified_file'|'missing'|'invalid';accuracy_verified:boolean;adapter_integrated:boolean}[]}
export interface VehiclePreparation<T> {version:number;document:T;capability:VehicleCapability}
export interface VehicleWatchlist {entries:{plate:string;note:string}[]}
export interface VehicleResult {state:string;text?:string|null;version:number;color_index?:number;support?:number;frame_count?:number;corrected?:boolean;reason?:string;delivery?:string;delivery_reason?:string}
export interface VehicleDetail {event_id:string;vehicle:VehicleResult;task?:{state:string;phase?:string;reason?:string;retryable:boolean}|null;frames:{key:string;captured_at:string}[];candidates?:{frame_key:string;result:{candidates?:{text?:string;status?:string}[]}}[]}
export const vehicleService={
  capability:()=>request<VehicleCapability>('/vehicle/capabilities'),
  retry:(id:string)=>request<VehicleDetail>(`/vehicle/records/${encodeURIComponent(id)}/retry`,{method:'POST',body:'{}'}),
  detail:(id:string)=>request<VehicleDetail>(`/vehicle/records/${encodeURIComponent(id)}`),
  image:(id:string,key:string,signal?:AbortSignal)=>requestBlob(`/vehicle/records/${encodeURIComponent(id)}/images/${encodeURIComponent(key)}`,signal),
  correct:(id:string,text:string,version:number)=>request<VehicleDetail>(`/vehicle/records/${encodeURIComponent(id)}/correction`,{method:'PUT',body:JSON.stringify({text,version})}),
  counters:()=>request<{items:Counter[];excluded:number;capability:VehicleCapability}>('/vehicle/counters',{signal:AbortSignal.timeout(15000)}),
  channel:(id:string)=>request<VehiclePreparation<{requested:boolean}>>(`/vehicle/channels/${encodeURIComponent(id)}`,{signal:AbortSignal.timeout(15000)}),
  saveChannel:(id:string,version:number,requested:boolean)=>request<VehiclePreparation<{requested:boolean}>>(`/vehicle/channels/${encodeURIComponent(id)}`,{method:'PUT',body:JSON.stringify({expected_version:version,document:{requested}}),signal:AbortSignal.timeout(15000)}),
  watchlist:()=>request<VehiclePreparation<VehicleWatchlist>>('/vehicle/watchlist',{signal:AbortSignal.timeout(15000)}),
  saveWatchlist:(version:number,document:VehicleWatchlist)=>request<VehiclePreparation<VehicleWatchlist>>('/vehicle/watchlist',{method:'PUT',body:JSON.stringify({expected_version:version,document}),signal:AbortSignal.timeout(15000)}),
}
