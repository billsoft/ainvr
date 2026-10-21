import {expect,it} from 'vitest'
import {readArmingSnapshot,buildArmingRequest,resetArmingForGeometry} from '@/features/armingDocument'
import type {ArmingDocument} from '@/features/armingDocument'
const zone={zone_id:'z',channel_id:'cam',name:'门',geometry_revision:'g',version:3,state:'active' as const,points:[[.1,.1],[.8,.1],[.8,.8]] as [number,number][],edge_ids:['e1','e2','e3']}
const assignment={assignment_id:'a',trigger_id:'t',input_stream_id:'cam',processor_id:'ai',zone_id:'z',zone_version:3,geometry_revision:'g',label_map_version:'labels',entry_edges:['e1'],exit_edges:[]}
const document:ArmingDocument={source_id:'cam',geometry_revision:'g',revision:2,zones:[zone],assignments:[assignment]}
it('explicit geometry reset keeps concurrency revision and removes old scopes without reusing evidence',()=>{
 const draft=resetArmingForGeometry('cam','new',document)
 expect(draft).toMatchObject({revision:2,geometryRevision:'new',zones:[],assignments:[]})
 expect(()=>buildArmingRequest(draft,document)).toThrow()
 expect(buildArmingRequest(draft,document,{},true)).toMatchObject({expectedRevision:2,removedZoneIds:['z'],removedAssignmentIds:['a']})
 expect(document.zones).toHaveLength(1)
 expect(()=>resetArmingForGeometry('other','new',document)).toThrow()
 const reused=readArmingSnapshot('cam','g',document);reused.geometryRevision='new'
 expect(()=>buildArmingRequest(reused,document,{},true)).toThrow()
})
it('round trips complete snapshot, retaining unchanged zones and label contract',()=>{
 const draft=readArmingSnapshot('cam','g',document)
 const result=buildArmingRequest(draft,document)
 expect(result.expectedRevision).toBe(2)
 expect(result.zones).toEqual([zone]);expect(result.assignments).toEqual([assignment])
})
it('only changed zone gets next version, and its assignment receives that version',()=>{
 const draft=readArmingSnapshot('cam','g',document)
 draft.zones[0]!.name='入口'
 const result=buildArmingRequest(draft,document)
 expect(result.zones[0]).toMatchObject({version:4,name:'入口'})
 expect(result.assignments[0]).toMatchObject({zone_version:4})
 expect(document.zones[0]!.name).toBe('门')
})
it('new scope requires an explicit label contract and starts zone version at one',()=>{
 const draft=readArmingSnapshot('cam','g',null)
 draft.zones=[{id:'z',name:'门',points:zone.points,edgeIds:zone.edge_ids,version:0}]
 draft.assignments=[{id:'new',triggerId:'t',processorId:'ai',zoneId:'z',entryEdges:[],exitEdges:[],version:0,needsDirectionConfirmation:false}]
 expect(()=>buildArmingRequest(draft,null)).toThrow('标签')
 expect(buildArmingRequest(draft,null,{new:'labels'}).zones[0]).toMatchObject({version:1})
})
it('changed geometry does not quietly reuse old frame or direction evidence',()=>{
 expect(()=>readArmingSnapshot('cam','new',document)).toThrow('画面规格')
 const draft=readArmingSnapshot('cam','g',document)
 draft.assignments[0]!.needsDirectionConfirmation=true
 expect(()=>buildArmingRequest(draft,document)).toThrow('方向')
})
it('removing zone also requires removal of its assignment and keeps complete request',()=>{
 const draft=readArmingSnapshot('cam','g',document);draft.zones=[]
 expect(()=>buildArmingRequest(draft,document)).toThrow()
 draft.assignments=[]
 const result=buildArmingRequest(draft,document)
 expect(result.zones).toEqual([]);expect(result.assignments).toEqual([])
})
it('assignment cannot reuse a previous label contract after changing processor',()=>{
 const draft=readArmingSnapshot('cam','g',document);draft.assignments[0]!.processorId='other'
 expect(()=>buildArmingRequest(draft,document)).toThrow('标签')
})
