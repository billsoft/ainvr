import {it,expect} from 'vitest'
import {reviewTrajectorySegments} from '@/features/reviewTrajectory'
const point=(n:number,eligible=true)=>({source_pts_ns:String(n),event_eligible:eligible,observation:eligible?'detected':'predicted',bbox:{x:n,y:0,w:2,h:2}})
it('does not bridge predictions or include future samples',()=>{
 expect(reviewTrajectorySegments([point(1),point(2),point(3,false),point(4),point(5),point(6)],'5')).toEqual(['2,2 3,2','5,2 6,2'])
})
it('honors the frozen anchor and malformed timestamps fail safely',()=>{
 expect(reviewTrajectorySegments([point(1),point(2)],'2','center')).toEqual(['2,1 3,1'])
 expect(reviewTrajectorySegments([point(1),{...point(2),source_pts_ns:'bad'},point(3)],'3')).toEqual([])
})
