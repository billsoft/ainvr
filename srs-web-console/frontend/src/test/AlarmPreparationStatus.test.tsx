import {render,screen} from '@testing-library/react'
import {it,expect,vi} from 'vitest'
import {AlarmRow} from '@/pages/AlarmCenter/AlarmRow'
import {reviewReason} from '@/features/alarmReview'
import type {AlarmEvent} from '@/api/alarmEventService'
it('explains evidence preparation retries and exhausted failures without calling them missing pixels',()=>{
 expect(reviewReason('evidence_preparation_retry')).toContain('自动重试')
 expect(reviewReason('evidence_preparation_failed')).toContain('人工')
 expect(reviewReason('storage_busy')).toContain('存储')
 expect(reviewReason('evidence_identity_mismatch')).toContain('身份')
})
it('shows preparation trouble on unreviewed list rows and hides it after a human decision',()=>{
 const alarm={alarm_id:'a',behavior:'appearance',occurred_at:'2026-10-30T00:00:00Z',rule:{id:'r',name:'r'},lifecycle:{state:'ended'},handling:{state:'unacknowledged',revision:0},review:{state:'failed',reason:'evidence_preparation_failed'}} as unknown as AlarmEvent
 const props={alarm,trigger:undefined,channelName:'测试',onHandle:vi.fn(),onOpen:vi.fn()}
 const view=render(<AlarmRow {...props}/>)
 expect(screen.getByRole('status')).toHaveTextContent('取证准备失败')
 view.rerender(<AlarmRow {...props} alarm={{...alarm,handling:{...alarm.handling,state:'acknowledged',reviewed_by_kind:'human',disposition:'handled'}}}/>)
 expect(screen.queryByText(/取证准备失败/)).not.toBeInTheDocument()
})
