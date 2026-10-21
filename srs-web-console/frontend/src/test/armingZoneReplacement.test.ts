import {it,expect} from 'vitest'
import {createArmingDraft} from '@/features/armingDraft'
it('whole zone replacement rejects duplicate name atomically and undoes both name and geometry',()=>{
 const z={id:'one',name:'one',version:1,points:[[0,0],[1,0],[1,1]] as [number,number][],edgeIds:['a','b','c']}
 const d=createArmingDraft({sourceId:'s',geometryRevision:'g',revision:1,zones:[z,{...z,id:'two',name:'two'}],assignments:[]})
 expect(()=>d.replaceZone({...z,name:'two',points:[[.1,.1],[1,0],[1,1]]})).toThrow('名称')
 expect(d.dirty()).toBe(false)
 d.replaceZone({...z,name:'new',points:[[.1,.1],[1,0],[1,1]]});d.undo()
 expect(d.read().zones[0]).toEqual(z);expect(d.canUndo()).toBe(false)
})
