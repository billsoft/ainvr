import {expect,it} from 'vitest'
import {unwrapErp,liftErp,erpDisplayPolygons} from '@/features/erpGeometry'
import {zoneGeometryError} from '@/features/alarmGeometry'
import {readArmingSnapshot,buildArmingRequest} from '@/features/armingDocument'
const points:[number,number][]=[[.9,.3],[.1,.3],[.1,.7],[.9,.7]]
it('validates a seam polygon in continuous longitude and draws copies at both ERP edges',()=>{
 const poly=unwrapErp(points);expect(poly[1]![0]).toBeCloseTo(1.1)
 expect(liftErp([.05,.5],poly)[0]).toBeCloseTo(1.05)
 expect(zoneGeometryError(points,true)).toBe('')
 const copies=erpDisplayPolygons(points,true);expect(copies).toHaveLength(2)
 expect(copies.every(p=>Math.max(...p.map(q=>q[0]))-Math.min(...p.map(q=>q[0]))<.21)).toBe(true)
 expect(erpDisplayPolygons(points,false)).toEqual([points])
})
it('round trips topology and stable edge IDs through the saved arming contract',()=>{
 const doc={coordinate_space:'erp' as const,source_id:'s',geometry_revision:'g',revision:1,zones:[{zone_id:'z',channel_id:'s',geometry_revision:'g',version:1,state:'active' as const,name:'seam',points,edge_ids:['a','b','c','d'],erp_wrap:true}],assignments:[]}
 const draft=readArmingSnapshot('s','g',doc),request=buildArmingRequest(draft,doc)
 expect(request.coordinateSpace).toBe('erp');expect(request.zones[0]).toEqual(doc.zones[0]);expect(draft.zones[0]?.erpWrap).toBe(true)
})
it('rejects winding or half-turn ambiguity instead of choosing a different region',()=>{
 expect(zoneGeometryError([[0,.3],[.5,.3],[.5,.7],[0,.7]],true)).not.toBe('')
 expect(()=>unwrapErp([[.1,.2],[.4,.2],[.7,.2],[.9,.2]])).toThrow()
})
