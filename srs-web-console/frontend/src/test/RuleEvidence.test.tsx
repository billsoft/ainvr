import {render,screen} from '@testing-library/react'
import {describe,it,expect} from 'vitest'
import {RuleEvidence} from '@/pages/AlarmCenter/RuleEvidence'
import type {AlarmEvent} from '@/api/alarmEventService'
describe('rule evidence',()=>{
 it('separates requirement, observation and unknown instead of presenting all as AI confirmed',()=>{
 const alarm={review_evidence:{version:'rule-evidence-v1',blocking:true,scope_note:'类别模型不独立证明行为',rule:{behavior:'appearance',behavior_name:'出现',labels:[{id:'p',name:'人员'}],label_mode:'any',region_required:true,anchor:'bottom_center',duration_ms:0},observations:[],checks:[{id:'spatial',title:'出现范围',status:'conflict',expected:'区域内',actual:'区域外',frames:[],basis:'observation_recalculation'},{id:'duration',title:'持续时间',status:'unknown',expected:'1秒',actual:'缺少开始帧',frames:[],basis:'engine_state'}]}} as unknown as AlarmEvent
 render(<RuleEvidence alarm={alarm}/>);expect(screen.getByRole('alert')).toHaveTextContent('不能据此自动确认');expect(screen.getByText('存在矛盾')).toBeInTheDocument();expect(screen.getByText('证据不足')).toBeInTheDocument();expect(screen.getByText(/限定布防区域/)).toBeInTheDocument()
 })
 it('does not fabricate historical evidence',()=>{render(<RuleEvidence alarm={{} as AlarmEvent}/>);expect(screen.getByText(/尚未提供逐条件核对/)).toBeInTheDocument()})
})
