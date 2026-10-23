import {expect,it} from 'vitest';
import {compileBinding} from '../store/flowCounters.js';
const def={counter_id:'visitors',name:'traffic',labels:[{label_id:'p',name:'person'}],method:'zone' as const,outputs:'both' as const,names:{in:'in',out:'out'},occupancy:false,max_gap_ms:1000,state:'enabled' as const};
const source={channel_id:'ai',input_stream_id:'camera',geometry_revision:'g',label_map_version:'lm',tracking_available:true,labels:[{label_id:'p',name:'person'}],width:1920,height:1080,stream_fingerprint:'a'.repeat(64),observed_at:'2026-10-21T00:00:00Z'};
const zone={zone_id:'door',channel_id:'camera',geometry_revision:'g',version:1,state:'active',points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]] as [number,number][],edge_ids:['top','right','bottom','left']};
const binding={binding_id:'flow-1',counter_id:'visitors',input_stream_id:'camera',processor_id:'ai',zone_id:'door',zone_version:1,geometry_revision:'g',label_map_version:'lm',direction:{kind:'edges',entry:['left'],exit:['right']}};
it('freezes pixel tolerance into newly compiled bindings',()=>{expect(compileBinding(def,1,binding,source,zone,1)?.hysteresis_px).toBe(5.4)});
it('rejects a zone with no possible stable interior while allowing a single line',()=>{
 const thin={...zone,points:[[.3,.3],[.301,.3],[.301,.7],[.3,.7]] as [number,number][]};
 expect(()=>compileBinding(def,1,binding,source,thin,1)).toThrow(/区域太窄/);
 expect(compileBinding({...def,method:'line'},1,{...binding,direction:{kind:'line',edge:'left',in_side:'inward'}},source,thin,1)).not.toBeNull();
});

it('rotated pixel-space rectangles retain clearance checks and stable edge mapping',()=>{
 for(const degrees of [0,15,30,45,90,135,180,270])for(const width of [8,10.8,12,100]){
  const angle=degrees*Math.PI/180;
  const points=([[-width/2,-150],[width/2,-150],[width/2,150],[-width/2,150]] as [number,number][]).map(([x,y]):[number,number]=>[(960+x*Math.cos(angle)-y*Math.sin(angle))/1920,(540+x*Math.sin(angle)+y*Math.cos(angle))/1080]);
  const rotated={...zone,points};
  if(width<=10.8)expect(()=>compileBinding(def,1,binding,source,rotated,1)).toThrow(/区域太窄/);
  else expect(compileBinding(def,1,binding,source,rotated,1)?.edge_ids).toEqual(zone.edge_ids);
  expect(compileBinding({...def,method:'line'},1,{...binding,direction:{kind:'line',edge:'left',in_side:'inward'}},source,rotated,1)?.passage?.edges).toEqual([3]);
  expect(compileBinding({...def,method:'gates'},1,{...binding,direction:{kind:'gates',from:'left',to:'right'}},source,rotated,1)?.passage?.edges).toEqual([3,1]);
 }
});

it('all counting modes reject coincident vertices before width validation, including the closing edge',()=>{
 for(const points of [[[.3,.3],[.3,.3],[.7,.7],[.3,.7]],[[.3,.3],[.7,.3],[.7,.7],[.3,.3]]] as [number,number][][]){
  for(const [method,direction] of [['zone',binding.direction],['line',{kind:'line',edge:'left',in_side:'inward'}],['gates',{kind:'gates',from:'left',to:'right'}]] as const){
   try{compileBinding({...def,method},1,{...binding,direction},source,{...zone,points},1);throw new Error('accepted invalid geometry')}
   catch(error){expect(error).toMatchObject({code:'invalid_geometry'});expect((error as Error).message).toMatch(/相邻顶点不能重合/)}
  }
 }
});
