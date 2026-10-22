import {useRef,type ComponentProps} from 'react'
import {ZoneEditor as Zone} from '@/pages/AlarmCenter/ZoneEditor'
import {AssignmentEditor as Assignment} from '@/pages/AlarmCenter/AssignmentEditor'
import {AssignmentPicker as Picker} from '@/pages/AlarmCenter/AssignmentPicker'
import type {WorkspaceDraft} from '@/pages/AlarmCenter/workspaceDraft'
// Unit tests drive the same flush contract as ArmingModal, without shipping a
// second standalone save/cancel flow in the product.
export function ZoneEditor(props:Omit<ComponentProps<typeof Zone>,'workspace'|'onEscape'>){
 const workspace=useRef<WorkspaceDraft|null>(null)
 return <><Zone {...props} workspace={workspace} onEscape={props.onCancel}/><button onClick={()=>workspace.current?.flush()}>提交草稿</button></>
}
export function AssignmentEditor(props:Omit<ComponentProps<typeof Assignment>,'workspace'>){
 const workspace=useRef<WorkspaceDraft|null>(null)
 return <><Assignment {...props} workspace={workspace}/><button onClick={()=>workspace.current?.flush()}>提交草稿</button></>
}
export function AssignmentPicker(props:Omit<ComponentProps<typeof Picker>,'workspace'>){
 const workspace=useRef<WorkspaceDraft|null>(null)
 return <><Picker {...props} workspace={workspace}/><button onClick={()=>workspace.current?.flush()}>提交草稿</button></>
}
