import {render,screen} from '@testing-library/react'
import {expect,it,vi} from 'vitest'
import {reviewDiagnostic} from '@/features/alarmReview'
import {AlarmRow} from '@/pages/AlarmCenter/AlarmRow'
import type {AlarmEvent} from '@/api/alarmEventService'

const review={state:'uncertain',reason:'manual_review_required',geometry_verified:true,reference:{state:'completed',reason:'manual_review_required'},frames:[{key:'a',roles:['entry_before']},{key:'b',roles:['entry_after']}],frame_scores:[.728597,.999974],policy:{approve_above:.95}} as NonNullable<AlarmEvent['review']>
it('explains the historical row without inventing authorization or missing behavior',()=>{
 const d=reviewDiagnostic(review)!
 expect(d.summary).toBe('关键帧目标核对仍不确定')
 const text=d.details.join(' ')
 expect(text).toContain('行为几何条件：已核验')
 expect(text).toContain('进入前：模型分数 0.728597（不是概率）')
 expect(text).toContain('进入后：模型分数 0.999974')
 expect(text).toContain('规则阈值：0.95（不代表当次自动确认授权）')
 expect(text).toContain('无法还原具体未通过条件')
 expect(text).not.toContain('0.99；')
})
it('distinguishes missing viewable frames and missing scores from geometry evidence',()=>{
 expect(reviewDiagnostic({...review,frames:[],frame_scores:[]})!.summary).toContain('缺少可查看')
 expect(reviewDiagnostic({...review,frame_scores:[]})!.summary).toContain('未记录模型分数')
 expect(reviewDiagnostic({...review,frame_scores:[]})!.summary).not.toContain('不确定')
})
it.each(['confirmed','frame_below_threshold','no_strong_frame','not_authorized'] as const)('uses optional recorded gate: %s',outcome=>{
 const d=reviewDiagnostic({...review,auto_confirmation:{version:1,outcome,minimum_frame_score:.81,strong_frame_score:.973,frame_scores:[.72,.98],failed_frame_indices:outcome==='frame_below_threshold'?[0]:[]}})!
 expect(d.details.join(' ')).toContain('逐帧最低阈值：0.81；强帧阈值：0.973')
 expect(d.details.join(' ')).not.toContain('规则阈值')
 if(outcome==='frame_below_threshold')expect(d.details.join(' ')).toContain('进入前：模型分数 0.72（不是概率） · 低于记录')
 expect(reviewDiagnostic({...review,auto_confirmation:{version:1,outcome,minimum_frame_score:null,strong_frame_score:null,frame_scores:[],failed_frame_indices:[]}})!.details.join(' ')).toContain('逐帧最低阈值：未记录')
})
it('leaves both manual actions enabled for the historical pending row',()=>{
 const alarm={alarm_id:'a',behavior:'appearance',occurred_at:'2026-10-30T00:00:00Z',rule:{id:'r',name:'r'},lifecycle:{state:'ended'},handling:{state:'unacknowledged',revision:0},review} as AlarmEvent
 render(<AlarmRow alarm={alarm} trigger={undefined} channelName="测试" onHandle={vi.fn()} onOpen={vi.fn()}/> )
 expect(screen.getByText(/关键帧目标核对仍不确定/)).toBeInTheDocument()
 expect(screen.getByRole('button',{name:'确认'})).toBeEnabled()
 expect(screen.getByRole('button',{name:'标记误报'})).toBeEnabled()
})
it('does not claim visual uncertainty from differing high scores or an invalid rule threshold',()=>{
 expect(reviewDiagnostic({...review,frame_scores:[.9999,.9998]})!.summary).toBe('未自动确认，待人工审核')
 for(const approve_above of [undefined,NaN,Infinity,-1,2])expect(reviewDiagnostic({...review,policy:{approve_above}})!.summary).toBe('未自动确认，待人工审核')
})
it('maps reviewed frame IDs rather than retained fallback order, including failed indices',()=>{
 const d=reviewDiagnostic({...review,frames:[{...review.frames![0]!,frame_id:'before'},{...review.frames![1]!,frame_id:'after'}],reviewed_frame_ids:['after','before'],auto_confirmation:{version:1,outcome:'frame_below_threshold',minimum_frame_score:.95,strong_frame_score:.999974,frame_scores:[.999974,.728597],failed_frame_indices:[1]}})!
 expect(d.details.join(' ')).toContain('进入后：模型分数 0.999974（不是概率）')
 expect(d.details.join(' ')).toContain('进入前：模型分数 0.728597（不是概率） · 低于记录')
 expect(d.details.join(' ')).toContain('强帧阈值：0.999974')
})
it('does not positionally associate mismatched legacy arrays or unknown reviewed IDs',()=>{
 for(const extra of [{frames:[review.frames![0]!]}, {reviewed_frame_ids:['unknown','also-unknown']}]){
  const text=reviewDiagnostic({...review,...extra})!.details.join(' ')
  expect(text).not.toContain('进入前：模型分数 0.728597')
  expect(text).toContain('模型分数未记录或无法对应')
 }
})
it('formats scores and thresholds consistently to six trimmed decimals',()=>{
 const text=reviewDiagnostic({...review,frame_scores:[.728597123456,.999974],policy:{approve_above:.95000000001}})!.details.join(' ')
 expect(text).toContain('模型分数 0.728597（不是概率）')
 expect(text).toContain('模型分数 0.999974（不是概率）')
 expect(text).toContain('规则阈值：0.95（')
 expect(text).not.toContain('0.728597123456')
})
