import {expect,it} from 'vitest'
import {render,screen,fireEvent,act,cleanup} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {afterEach,vi} from 'vitest'
import {ReviewFrames} from '@/pages/AlarmCenter/ReviewFrames'
import {reviewDiagnostic,automaticReviewBanner} from '@/features/alarmReview'
import type {AlarmEvent} from '@/api/alarmEventService'
const {request}=vi.hoisted(()=>({request:vi.fn().mockResolvedValue({jpeg_base64:'expanded-image'})}))
vi.mock('@/api/httpClient',()=>({request}))
afterEach(()=>{cleanup();vi.clearAllMocks()})
const frame={frame_id:'before',key:'original',captured_at:'2026-10-30T00:00:00Z',source_pts_ns:'1',bbox:{x:0,y:0,w:20,h:20}}
const primary={state:'uncertain',reason:'manual_review_required',geometry_verified:true,frames:[frame,{...frame,frame_id:'after',key:'original-after'}],frame_scores:[.728597,.999974],policy:{approve_above:.95}} satisfies AlarmEvent['review']
const secondary={version:'expanded-target-v1',state:'completed',outcome:'confirmed',frame_scores:[.987654],frames:[{frame_id:'before',key:'context-before',score:.987654}],prompt:'当次场景输入说明',completed_at:'2026-10-30T00:01:00Z',confirm_above:.95,reject_below:.1} as const
function alarm(mismatch=false):AlarmEvent{return {alarm_id:'a',behavior:'appearance',occurred_at:frame.captured_at,last_seen_at:frame.captured_at,channel_id:'c',severity:'low',rule:{id:'r',name:'r'},lifecycle:{state:'ended'},handling:{state:'unacknowledged',revision:0},review:{...primary,secondary:{...secondary,frame_scores:[...secondary.frame_scores],frames:[...secondary.frames]},secondary_frames:[{frame_id:'before',key:mismatch?'wrong-context':'context-before',layout:'context',width:640,height:640}]}}}
it.each(['confirmed','false_positive'] as const)('uses secondary %s over legacy .728/.999 primary uncertainty',outcome=>{
 const value=alarm();value.review!.secondary!.outcome=outcome
 const d=reviewDiagnostic(value.review)!
 expect(d.summary).toBe(`特写 + 扩大范围复核 · AI复核结果：${outcome==='confirmed'?'确认':'误报'}`)
 expect(d.details.join(' ')).toContain('模型分数 0.728597（不是概率）')
 expect(d.details.join(' ')).toContain('模型分数 0.999974（不是概率）')
 expect(d.details.join(' ')).toContain('扩大范围复核 · 关键帧 1：模型分数 0.987654（不是概率）')
})
it('preserves old diagnostics and keeps uncertain/unavailable pending',()=>{
 expect(reviewDiagnostic(primary)!.summary).toBe('关键帧目标核对仍不确定')
 const value=alarm();value.review!.secondary!.outcome='uncertain'
 expect(reviewDiagnostic(value.review)!.summary).toContain('结论不确定，待人工审核')
 value.review!.secondary!.state='unavailable';value.review!.secondary!.outcome='false_positive'
 expect(reviewDiagnostic(value.review)!.summary).toContain('不可用，待人工审核')
})
it.each([false,true])('loads expanded images and matches saved frame ID/key (mismatch=%s)',async mismatch=>{
 await act(async()=>{render(<MemoryRouter><ReviewFrames alarm={alarm(mismatch)}/></MemoryRouter>)})
 fireEvent.click(screen.getByRole('button',{name:/关键帧 1/}))
 fireEvent.click(screen.getByRole('button',{name:'扩大范围复核输入'}))
 expect(request).toHaveBeenCalledWith('/alarms/events/a/review-frames/'+(mismatch?'wrong-context':'context-before'))
 if(mismatch)expect(screen.getByText('未记录此关键帧的扩大范围复核输入')).toBeInTheDocument()
 else expect(screen.getByAltText('关键帧 1')).toHaveAttribute('src','data:image/jpeg;base64,expanded-image')
 expect(screen.getByText(secondary.prompt)).toBeInTheDocument()
 expect(screen.getByText(/扩大截图范围补充周围线索，仍核对同一个目标/)).toBeInTheDocument()
})

it('keeps confirm-only and dual-mode banner contracts separate',()=>{
 expect(automaticReviewBanner('confirm_only')).toContain('疑似误报、证据不足或判断冲突保留人工审核')
 expect(automaticReviewBanner('confirm_only')).not.toContain('自动确认或判为误报')
 expect(automaticReviewBanner('confirm_or_reject')).toContain('自动确认或判为误报')
 expect(automaticReviewBanner('confirm_or_reject')).toContain('结论不确定、证据不足或复核不可用时保留人工审核')
})

it('labels secondary scores with roles and keeps storage IDs out of display',()=>{
 const value=alarm();value.review!.frames![0]!.roles=['entry_before']
 const text=reviewDiagnostic(value.review)!.details.join(' ')
 expect(text).toContain('扩大范围复核 · 进入前：模型分数 0.987654')
 expect(text).not.toContain('context-before')
})
it('keeps limited-evidence warning when secondary is unavailable',async()=>{
 const value=alarm();value.review!.evidence_mode='verified_behavior_available_visuals';value.review!.secondary!.state='unavailable'
 await act(async()=>{render(<MemoryRouter><ReviewFrames alarm={value}/></MemoryRouter>)})
 expect(screen.getByRole('note')).toHaveTextContent('部分全景关键帧未留存')
})
it.each([
 ['secondary_class_confirmed','支持目标类别'],
 ['secondary_class_rejected','不支持目标类别'],
 ['insufficient_class_evidence','目标类别证据不足'],
 ['incomplete_frames','审核关键帧不完整'],
 ['conflicting_or_weak_primary','特写主审结果冲突或证据较弱'],
 ['authorization_changed','自动审核授权已变化'],
])('explains secondary reason %s', (reason,label)=>{
 const value=alarm();value.review!.secondary!.reason=reason
 const text=reviewDiagnostic(value.review)!.details.join(' ')
 expect(text).toContain(label);expect(text).not.toContain(reason)
})
it('discloses unvalidated model accuracy once in the dual banner',()=>{
 expect(automaticReviewBanner('confirm_or_reject').match(/模型准确率尚未全面验证/g)).toHaveLength(1)
})

it('separates negative third-pass evidence from target scores with readable frame labels',()=>{
 const value=alarm();value.review!.frames![0]!.roles=['entry_before']
 value.review!.secondary!.reason='insufficient_non_target_evidence'
 value.review!.secondary!.non_target_evidence={frame_scores:[.98],frame_ids:['before'],prompt:'必须清晰可辨且不是人员；昏暗不清晰回答否。'}
 const text=reviewDiagnostic(value.review)!.details.join(' ')
 expect(text).toContain('进入前：明确非人员证据分数 0.98（不是目标匹配分数，也不是概率）')
 expect(text).toContain('无法清晰排除人员，保留人工审核')
 expect(text).toContain('明确非人员证据分数 ≥ 未记录（至少 0.99')
 expect(text).toContain(value.review!.secondary!.non_target_evidence!.prompt)
 expect(text).toContain('扩大范围复核 · 进入前：模型分数 0.987654')
})

it.each([
 ['primary_confirmation','特写主审确认'],
 ['expanded_confirmation','扩大范围复核确认'],
 ['explicit_non_target','明确非人员证据核验后判为误报'],
] as const)('renders recorded path %s separately from authorization basis', (decision_path,label)=>{
 const value=alarm();value.review!.decision_path=decision_path
 value.review!.decision_basis='operator_authorized_primary_review'
 const diagnostic=reviewDiagnostic(value.review)!
 expect(diagnostic.summary).toContain(`实际审核路径：${label}`)
 expect(diagnostic.details.join(' ')).toContain('决策依据：用户授权的特写主审策略')
})
it('supports a primary path without secondary metadata and does not infer paths for old records',()=>{
 const value=alarm();delete value.review!.secondary
 value.review!.decision_path='primary_confirmation'
 expect(reviewDiagnostic(value.review)!.summary).toContain('实际审核路径：特写主审确认')
 delete value.review!.decision_path;value.review!.decision_basis='operator_authorized_dual_review'
 expect(reviewDiagnostic(value.review)!.summary).not.toContain('实际审核路径')
})
it('shows all three negative gates including stricter saved authorization and rule thresholds',()=>{
 const value=alarm();value.review!.policy!.reject_below=.03
 value.review!.secondary!.reject_below=.002
 value.review!.authorization={mode:'confirm_or_reject',secondary:{confirm_above:.99,reject_below:.002}}
 const text=reviewDiagnostic(value.review)!.details.join(' ')
 expect(text).toContain('特写人员分数 ≤ 0.03；扩大范围人员分数 ≤ 0.002；明确非人员证据分数 ≥ 0.998')
})
it('uses supplied banner labels without claiming person-only support for every model',()=>{
 expect(automaticReviewBanner('confirm_or_reject',['person'])).toContain('授权类别：人员')
 expect(automaticReviewBanner('confirm_only',['vehicle'])).toContain('授权类别：vehicle')
 expect(automaticReviewBanner('confirm_only')).toContain('仅对当前已授权的目标类别生效')
 expect(automaticReviewBanner('confirm_only')).not.toContain('人员')
})
