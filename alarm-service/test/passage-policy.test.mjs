import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRule} from '../src/domain.mjs';
import {evaluate} from '../src/engine.mjs';
const rule={id:'r',name:'r',channel_id:'c',version:1,state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'region_traverse',alarm_enabled:false,points:[[.2,.2],[.8,.2],[.8,.8],[.2,.8]]};
test('passage policy rejects malformed, ambiguous and alarm geometry overrides',()=>{
 for(const passage of [{kind:'line',edges:[9],max_gap_ms:1000},{kind:'gates',edges:[1,1],max_gap_ms:1000},{kind:'zone',edges:[],max_gap_ms:1000},{kind:'zone',max_gap_ms:2001}])assert.throws(()=>validateRule({...rule,passage}));
 assert.throws(()=>validateRule({...rule,alarm_enabled:true,passage:{kind:'line',edges:[1],max_gap_ms:0}}));
 assert.equal(validateRule({...rule,passage:{kind:'gates',edges:[3,1],max_gap_ms:1000}}).passage.kind,'gates');
});
test('rule cache revalidates complete contents even when caller reuses an ID and version',()=>{
 const pts='1000000000',f={schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:'1',frame_id:'1',source_pts_ns:pts,captured_at:'2026-10-21T00:00:00Z',source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:[]};
 evaluate(null,f,[rule]);assert.throws(()=>evaluate(null,f,[{...rule,points:[[.2,.2],[.2,.2],[.8,.8]]}]));
});
