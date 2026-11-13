import {expect,it} from 'vitest';
import {catalogRebindAllowed} from '../services/alarmCatalogRebind.js';
const source={channel_id:'ai',input_stream_id:'camera',geometry_revision:'g',label_map_version:'new',stream_fingerprint:'a'.repeat(64),observed_at:'2026-11-13T04:00:01Z',width:1920,height:1080,tracking_available:true,labels:[{label_id:'class:0',name:'person',description:''}]};
const binding={processor_id:'ai',input_stream_id:'camera',geometry_revision:'g',label_map_version:'old'};
const previous={source_binding:{...source,label_map_version:'old',not_before:'2026-11-13T04:00:00Z'}};
const definition={labels:[{label_id:'class:0',name:'person'}]};
it('only repairs the directory version when the selected meaning and camera are unchanged',()=>{
 expect(catalogRebindAllowed(binding,definition,previous,source)).toBe(true);
 expect(catalogRebindAllowed(binding,definition,previous,{...source,labels:[...source.labels,{label_id:'fire',name:'fire',description:''}]})).toBe(true);
 for(const patch of [{channel_id:'other'},{input_stream_id:'other'},{geometry_revision:'other'},{stream_fingerprint:'b'.repeat(64)},{width:3840},{height:2160},{observed_at:'2026-11-13T03:59:59Z'},{labels:[]},{labels:[{label_id:'class:0',name:'car'}]},{labels:[{label_id:'class:0',name:'person',description:'person in red'}]}])
  expect(catalogRebindAllowed(binding,definition,previous,{...source,...patch}),JSON.stringify(patch)).toBe(false);
 expect(catalogRebindAllowed(binding,definition,null,source)).toBe(false);
});
it('open vocabulary requires the exact saved model and prompt, never just a display name',()=>{
 const model={name:'custom',adapter:'yoloe_bpu',mode:'open' as const};
 const d={target_model:model,labels:[{label_id:'class:0',name:'person',description:'worker wearing blue'}]};
 const s={...source,target_model:model,labels:[{label_id:'class:0',name:'person',description:'worker wearing blue'}]};
 expect(catalogRebindAllowed(binding,d,previous,s)).toBe(true);
 expect(catalogRebindAllowed(binding,d,previous,{...s,target_model:{...model,name:'other'}})).toBe(false);
 expect(catalogRebindAllowed(binding,d,previous,source)).toBe(false);
});
