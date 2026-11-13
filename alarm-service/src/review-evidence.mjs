// Rule snapshots and raw observations are evidence, not instructions to a model.
import {inside,boundaryDistancePx,boundaryStable,validatePoints,stateSpatial} from './geometry.mjs';
import {digest} from './domain.mjs';
import {buildRegionReviewEvidence} from './region-review-evidence.mjs';
export const EVIDENCE_VERSION='rule-evidence-v1';
const names={appearance:'出现',region_approach:'接近布防区',region_enter:'侵入布防区',region_traverse:'穿越布防区'};
const ms=(a,b)=>Number(BigInt(a)-BigInt(b))/1e6;
const finite=v=>typeof v==='number'&&Number.isFinite(v);
function build(row){
 if(row.incident_scope==='region'||row.rule?.snapshot?.region_state)return buildRegionReviewEvidence(row);
 const r=row.rule?.snapshot,c=row.analysis_evidence?.review_context,g=row.analysis_evidence?.group,source=row.analysis_evidence?.source;
 const stateRule=r?.spatial_semantics==='bbox-state-v1';
 const checks=[],observations=[];
 const add=(id,title,status,expected,actual,frames=[],basis='observation_recalculation')=>checks.push({id,title,status,expected,actual,frames,basis});
 const finish=()=>({version:EVIDENCE_VERSION,rule_digest:r?digest(r):null,scope:g?'group':'single',rule:r?{behavior:r.behavior,behavior_name:names[r.behavior]??r.behavior,labels:(r.labels??[]).map(x=>({id:x.label_id,name:x.name})),label_mode:r.group?.labels??'any',region_required:!!r.points?.length,zone_id:r.zone_id??null,zone_version:r.zone_version??null,anchor:r.anchor??'bottom_center',spatial_semantics:r.spatial_semantics??'legacy-anchor-transition',duration_ms:r.duration_ms??0,approach_px:r.approach_px??null,entry_edges:r.entry_edges??[],exit_edges:r.exit_edges??[],group:r.group??null}:null,checks,observations,blocking:checks.some(x=>x.status==='conflict'),scope_note:'空间关系由原始检测框复算；连续性仍依赖触发引擎的状态证明。类别模型不独立证明行为。'});
 if(!r||!source||!finite(source.width)||!finite(source.height)||source.width<=0||source.height<=0){add('source','规则与画面尺寸','unknown','告警发生时的规则和原始尺寸','缺少快照');return finish();}
 if(r.erp_wrap){add('geometry','全景坐标','unknown','展开后的全景几何','此版本不独立复算全景');return finish();}
 const region=Array.isArray(r.points)&&r.points.length>0;
 if(region){try{validatePoints(r.points);}catch{add('region','布防区域','conflict','有效多边形','区域坐标无效');return finish();}}
 else if(r.behavior!=='appearance'){add('region','布防区域','conflict','行为必须关联区域','缺少区域');return finish();}
 add('region','布防区域',region?'pass':'not_applicable',region?'按历史区域版本核对':'全画面出现',region?`区域版本 ${r.zone_version??'未记录'}`:'无需布防区',[], 'rule_snapshot');
 function observe(s){
  const b=s?.bbox;
  if(!s||!b||!['x','y','w','h'].every(k=>finite(b[k]))||b.x<0||b.y<0||b.w<=0||b.h<=0||b.x+b.w>source.width+.001||b.y+b.h>source.height+.001||!/^\d+$/.test(String(s.source_pts_ns))){add('invalid_sample','原始观测','conflict','有效坐标和帧时间','观测无效');return null;}
  const point=[(b.x+b.w/2)/source.width,(b.y+b.h*(r.anchor==='center'?.5:1))/source.height];
  const o={frame_id:s.frame_id,source_pts_ns:s.source_pts_ns,captured_at:s.captured_at,track_id:s.track_id,label_id:s.label_id,roles:s.roles??[],bbox:b,point,inside:region?inside(r.points,point):null,distance_px:region?boundaryDistancePx(r.points,point,source.width,source.height):null,stable:region?boundaryStable(r,{source},point):null};
  if(stateRule)Object.assign(o,stateSpatial(r,{source},b));
  observations.push(o);return o;
 }
 if(g){
  const members=Array.isArray(g.members)?g.members:[];
  if(members.length>16){add('capacity','成员证据','conflict','最多16个留存成员','超出协议');return finish();}
  add('group_integrity','组合证据版本',g.proof_version===2&&row.analysis_evidence.group_digest===digest([r,g,row.frame_id,row.stream_session_id])?'pass':'conflict','版本2且摘要一致',`版本 ${g.proof_version??'未知'}`,[],'proof_integrity');
  const seen=new Set(),labels=new Set();let valid=0,current=0;
  for(const m of members){const o=observe(m.sample);if(!o)continue;labels.add(o.label_id);if(seen.has(o.track_id))add('duplicate_identity','目标去重','conflict','不同目标ID','重复ID',[o.frame_id]);seen.add(o.track_id);
   if(!r.label_ids?.includes(o.label_id))add('member_label','成员标签','conflict','规则允许标签','成员标签不匹配',[o.frame_id]);
   if(g.mode==='simultaneous'){
    // Simultaneous: each member's last real qualifying sighting is at most window_ms
    // before the trigger frame (the window tolerates missed detections; it is not a dwell).
    const age=ms(row.source_pts_ns,o.source_pts_ns);
    const common=o.frame_id===row.frame_id;
    const spatial=stateRule?o.match:!region||r.behavior==='region_approach'?(!region||!o.inside&&o.distance_px<=r.approach_px):o.inside;
    const ok=spatial&&age>=0&&age<=r.group.window_ms;
    if(ok){valid++;if(common)current++;}
    add('member_'+o.track_id,'成员同时满足',ok?'pass':'conflict',`触发前 ${r.group.window_ms}ms 内真实满足`,`${Math.round(age)}ms 前，${o.inside===null?'全画面':o.inside?'区域内':'区域外'}`,[o.frame_id], 'sample_endpoints_and_engine_continuity');
   }else{const age=ms(row.source_pts_ns,o.source_pts_ns),ok=age>=0&&age<=r.group.window_ms&&m.stage_proven===true;if(ok)valid++;add('member_'+o.track_id,'窗口内通过',ok?'pass':'conflict',`完成穿越且距触发≤${r.group.window_ms}ms`,`${Math.round(age)}ms`,[o.frame_id],'member_transition_proof');}
  }
  if(g.mode==='simultaneous')add('trigger_frame','触发帧观测',current>0?'pass':'conflict','触发帧有真实满足的成员',`${current} 个`,[row.frame_id],'sample_endpoints_and_engine_continuity');
  const labelOK=r.group?.labels!=='all'||r.label_ids.every(x=>labels.has(x));
  add('count','数量与标签组合',valid>=r.group.minimum&&labelOK?'pass':'conflict',`至少${r.group.minimum}个；${r.group.labels==='all'?'全部标签同时满足':'任一允许标签'}`,`${valid}个符合留存条件；标签${labelOK?'齐全':'不足'}`);
  add('candidate_coverage','候选覆盖',g.candidates_truncated||g.candidate_count>members.length||!g.window_complete?'unknown':'pass','误报判定需要完整候选集合',`${members.length}/${g.candidate_count}，${g.window_complete?'窗口完整':'窗口尚未完整'}`,[],'engine_state');
  return finish();
 }
 const samples=c?.samples??c?.trace??[];
 if(!samples.length||samples.length>64){add('samples','关键帧','unknown','有界关键帧证据','未保存或超出兼容范围');return finish();}
 for(const s of samples)observe(s);
 if(checks.some(x=>x.status==='conflict'))return finish();
 const oo=observations;
 const order=oo.every((o,i)=>!i||BigInt(o.source_pts_ns)>BigInt(oo[i-1].source_pts_ns));
 const identities=oo.every(o=>o.track_id===row.track_ids?.[0]&&r.label_ids?.includes(o.label_id));
 add('identity','帧顺序与指定目标',order&&identities?'pass':'conflict','同一目标、允许标签、时间递增',order&&identities?'一致':'目标或时序不一致',oo.map(o=>o.frame_id));
 const last=oo.at(-1),byRole=role=>oo.find(o=>o.roles.includes(role));
 if(r.behavior==='appearance')add('spatial','出现范围',!region||oo.filter(o=>!o.roles.includes('开始前')).every(o=>o.inside)?'pass':'conflict',region?'有效检出在区域内':'画面中出现',region?'按判定点复算':'无需区域判断',oo.map(o=>o.frame_id));
 if(stateRule)add('spatial',r.behavior==='region_enter'?'碰撞侵入状态':'接近状态',oo.every(o=>o.match)?'pass':'conflict',r.behavior==='region_enter'?'检测框与区域相交或接触':`检测框到区域距离≤${r.approach_px}px`,`${last.overlap?'与区域相交':'区域外'}，距离${last.distance_px.toFixed(1)}px`,oo.map(o=>o.frame_id));
 if(!stateRule&&r.behavior==='region_enter'){
  const a=byRole('进入前'),b=byRole('进入后');
  add('spatial','进入过程',!a||!b?'unknown':!a.inside&&b.inside&&a.stable&&b.stable&&last.inside?'pass':'conflict','稳定区域外→区域内','进入前后及触发点复算',[a?.frame_id,b?.frame_id,last.frame_id].filter(Boolean));
 }
 if(!stateRule&&r.behavior==='region_approach'){
  const after=byRole('进入接近带后');
  add('spatial','接近范围',!after?'unknown':[after,last].every(o=>!o.inside&&o.distance_px<=r.approach_px+.001)?'pass':'conflict',`区域外，边界距离≤${r.approach_px}px`,`${last.inside?'区域内':'区域外'}，距离${last.distance_px?.toFixed(1)}px`,[last.frame_id]);
 }
 if(r.behavior==='region_traverse'){
  const a=byRole('进入前'),b=byRole('进入后'),d=byRole('离开后');
  const t=row.analysis_evidence.traversal;
  // Straight through between two frames: both keyframes are outside, on opposite sides.
  if(t?.interior_observed===false)add('spatial','穿越过程',!a||!d?'unknown':!a.inside&&!d.inside?'pass':'conflict','区域外→连线穿过区域→区域外','前后两帧位置连线复算',[a?.frame_id,d?.frame_id].filter(Boolean));
  else add('spatial','穿越过程',!a||!b||!d?'unknown':!a.inside&&b.inside&&!d.inside?'pass':'conflict','区域外→区域内→区域外','逐关键帧复算',[a?.frame_id,b?.frame_id,d?.frame_id].filter(Boolean));
  add('continuity','穿越连续性',t?.trajectory_complete===true&&t?.observation_gaps===0?'pass':'unknown','轨迹完整且无观测缺口',t?`缺口${t.observation_gaps??'未知'}，耗时${t.duration_ms??'未知'}ms`:'未记录',[],'engine_state');
 }
 const start=byRole(stateRule?'状态满足起点':r.behavior==='appearance'?'首次有效检出':r.behavior==='region_approach'?'进入接近带后':'进入后');
 if(r.duration_ms>0){const span=start?ms(last.source_pts_ns,start.source_pts_ns):null;add('duration','持续时间',span===null?'unknown':span+0.001>=r.duration_ms?'pass':'conflict',`≥${r.duration_ms}ms`,span===null?'未记录开始帧':`关键帧跨度${Math.round(span)}ms；连续性由引擎状态证明`,[start?.frame_id,last.frame_id].filter(Boolean),'sample_endpoints_and_engine_continuity');}
 else add('duration','持续时间','not_applicable','未配置持续时长','不附加时长要求');
 for(const [key,field] of [['entry_edges',r.behavior==='region_approach'?'nearest_edge':'entry_edge'],['exit_edges','exit_edge']])if(r[key]?.length)add(key,key==='entry_edges'?'进入方向':'离开方向',r[key].includes(row.direction?.[field])?'pass':'conflict',`允许边 ${r[key].map(n=>n+1).join('、')}`,row.direction?.[field]==null?'未记录':`边 ${row.direction[field]+1}`,[],'engine_boundary_crossing');
 return finish();
}
export function reviewTaskContext(row,sample){
 const r=row.rule.snapshot;
 // The existing category-only wire protocol accepts generic observation roles.
 // Keep state-specific proof roles in storage, translate only at this boundary.
 const roles=(sample.roles??[]).map(x=>x==='状态满足起点'?'首次有效检出':x==='状态满足触发'?'当帧检出':x);
 return {version:EVIDENCE_VERSION,behavior:r.behavior,region_required:!!r.points?.length,anchor:r.anchor??'bottom_center',duration_ms:r.duration_ms??0,approach_px:r.behavior==='region_approach'?r.approach_px:null,roles:roles.filter(x=>typeof x==='string'&&x.length<=24).slice(0,4),scope:'target_category_only'};
}

export function buildReviewEvidence(row){try{return build(row);}catch{return {version:EVIDENCE_VERSION,rule:null,checks:[{id:'malformed',title:'证据格式',status:'unknown',expected:'可解析的原始证据',actual:'证据缺失或格式不兼容',frames:[],basis:'validation'}],observations:[],blocking:true,scope_note:'不能根据损坏或不兼容的证据自动处理。'};}}

export function spatialBounds(row){
 const r=row.rule.snapshot,source=row.analysis_evidence.source;
 const points=[...(r.points??[])];
 for(const sample of row.analysis_evidence.review_context?.samples??row.analysis_evidence.review_context?.trace??[]){const b=sample.bbox;points.push([b.x/source.width,b.y/source.height],[(b.x+b.w)/source.width,(b.y+b.h)/source.height]);}
 if(!points.length||points.some(p=>p.some(v=>!Number.isFinite(v)||v<0||v>1)))throw Error('invalid_spatial_bounds');
 return [Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
}
