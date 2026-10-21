import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/http.mjs';
import {BehaviorEvents} from '../src/behavior-events.mjs';

test('statistics use operator authentication, reject unknown filters, and preserve coverage uncertainty',async()=>{
  let calls=0;
  const apiToken='statistics-test-only-'.repeat(3);
  const headers={authorization:`Bearer ${apiToken}`};
  const app=createApp({apiToken,repository:{behaviors:{statistics:async query=>{
    calls++;assert.equal(query.channel_id,'gate');
    return {items:[{event_type:'region_enter',occurrences:3,tracked_targets:2}],coverage:{state:'unknown'}};
  }}}});
  try{
    const url='/v1/behavior-statistics?from=2026-10-19T00:00:00Z&to=2026-10-20T00:00:00Z&channel_id=gate';
    assert.equal((await app.inject(url)).statusCode,401);
    assert.equal((await app.inject({url:url+'&status=acknowledged',headers})).statusCode,422);
    assert.equal(calls,0);
    const response=await app.inject({url,headers});
    assert.equal(response.statusCode,200);
    assert.equal(response.json().coverage.state,'unknown');
    assert.equal(response.json().items[0].occurrences,3);
    assert.equal(calls,1);
  }finally{await app.close();}
});

test('invalid statistics intervals fail before database access',async()=>{
  const facts=new BehaviorEvents({collection:()=>({aggregate:()=>{throw Error('must not query');}})});
  for(const range of [{},{from:'bad',to:'bad'},
    {from:'2026-10-19',to:'2026-10-18'},
    {from:'2026-01-01',to:'2026-12-31'}]){
    await assert.rejects(facts.statistics(range),error=>error.code==='invalid_time_range');
  }
});
