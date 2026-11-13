import {digest} from './domain.mjs';
const names={fire_smoke:'疑似烟雾 / 明火',helmet_violation:'疑似未戴安全帽',region_count:'区域人数异常',region_absence:'区域连续无人',vehicle_dwell:'区域车辆停留',suspected_down:'疑似倒地'};
// Region proof has no fictional target box or track. Count/continuity are engine
// observations; they are not independent visual confirmation of a semantic event.
export function buildRegionReviewEvidence(row){
 const r=row.rule?.snapshot,p=r?.region_state,c=row.analysis_evidence?.review_context;
 const proof=c?.proof,samples=c?.samples;
 const checks=[],observations=[];
 const add=(id,title,ok,expected,actual,basis='engine_state')=>checks.push({id,title,status:ok?'pass':'conflict',expected,actual,frames:[],basis});
 const result=()=>({version:'rule-evidence-v1',scope:'region',rule_digest:r?digest(r):null,
  rule:p?{behavior:r.behavior,behavior_name:names[p.event_kind]??p.event_kind,labels:(r.labels??[]).map(x=>({id:x.label_id,name:x.name})),label_mode:'any',region_required:!!r.points?.length,anchor:r.anchor??'bottom_center',duration_ms:p.duration_ms,group:null}:null,
  checks,observations,blocking:checks.some(x=>x.status==='conflict'),scope_note:'区域状态按有效采样计时；区域人数不是唯一人数或通行次数。这里核对的是引擎记录，仍需结合原图及完整录像审核；不采用人员类别自动复核策略。'});
 if(!p||!proof||!Array.isArray(samples)||samples.length<2||samples.length>3){add('region_proof','区域证据格式',false,'有界起止帧及规则快照','缺少区域证明');return result();}
 add('integrity','快照与证据摘要',proof.rule_digest===digest(r)&&c.integrity===digest({samples,proof})&&proof.event_kind===p.event_kind,'规则及证据摘要一致','发生时的不可变规则与起止帧','proof_integrity');
 const valid=samples.every((s,i)=>s?.identity_kind==='region'&&s.validity==='valid'&&s.observation==='region'
  &&Number.isSafeInteger(s.count)&&s.count>=0&&typeof s.frame_id==='string'&&/^\d+$/.test(s.source_pts_ns)
  &&(!i||BigInt(s.source_pts_ns)>BigInt(samples[i-1].source_pts_ns)));
 add('observations','有效区域观测',valid,'真实区域采样、时间递增、人数非负',`${samples.length} 张区域关键帧`);
 if(!valid)return result();
 const matches=n=>p.operator==='count_below'?n<p.threshold:n>=p.threshold;
 add('count','区域触发条件',samples.every(s=>matches(s.count)),`${p.operator==='count_below'?'少于':'至少'} ${p.threshold} 个`,samples.map(s=>s.count).join(' → '));
 const span=Number(BigInt(samples.at(-1).source_pts_ns)-BigInt(samples[0].source_pts_ns))/1e6;
 const duration=Number.isFinite(proof.valid_duration_ms)&&proof.valid_duration_ms>=p.duration_ms&&Math.abs(span-proof.valid_duration_ms)<0.001
  &&Number.isSafeInteger(proof.sample_count)&&proof.sample_count>=samples.length&&proof.max_interval_ms>0&&proof.max_interval_ms<=p.max_gap_ms;
 add('duration','有效观测持续时间',duration,`持续至少 ${p.duration_ms/1000} 秒，单次间隔不超过 ${p.max_gap_ms/1000} 秒`,`${proof.valid_duration_ms/1000} 秒，${proof.sample_count} 次采样`);
 add('trigger_frame','触发帧对应关系',samples.at(-1).frame_id===row.frame_id&&samples.at(-1).source_pts_ns===row.source_pts_ns,'末帧等于本次触发帧','按帧身份与源时间核对','source_frame_identity');
 observations.push(...samples.map((s,i)=>({frame_id:s.frame_id,captured_at:s.captured_at,track_id:'',roles:[i===0?'持续起点':i===samples.length-1?'触发时刻':'持续采样'],inside:null,distance_px:null,point:null,region_count:s.count})));
 checks.push({id:'semantic_review',title:'图像语义审核',status:'unknown',expected:'结合原图及规则确认候选事件',actual:'当前类别未启用自动审核；可人工确认或标为误报',frames:samples.map(s=>s.frame_id),basis:'human_review_required'});
 return result();
}
