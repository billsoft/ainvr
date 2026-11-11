import test from 'node:test';
import assert from 'node:assert/strict';
import {gapAllowance, holdPassage} from '../src/passage-continuity.mjs';

test('configured passage deadline is milliseconds, independent of sampling cadence', () => {
  const rule = {passage:{max_gap_ms:1500}};
  for (const cadence of [1000/2,1000/3,1000/4,1000/6,480,520]) {
    assert.equal(gapAllowance(rule, cadence),1500);
    for (const elapsed of [1499,1500,1501,1520,1680,1820]) {
      const state = {passage_observation:{pts:'1000000000'},
        traversal:{line_pending:{samples:2,since:123}}};
      const frame = {source_pts_ns:String(1000000000n+BigInt(elapsed)*1000000n)};
      assert.equal(holdPassage(rule,frame,state,cadence),elapsed<=1500,
        'cadence='+cadence+' elapsed='+elapsed);
      assert.equal(state.traversal.line_pending.samples,0);
      assert.equal(state.traversal.line_pending.since,null);
    }
  }
});
test('alarm gaps remain strict and default statistics deadline stays bounded', () => {
  assert.equal(gapAllowance({alarm_enabled:true}),0);
  assert.equal(gapAllowance({alarm_enabled:false}),1000);
  assert.equal(gapAllowance({alarm_enabled:false,passage:{max_gap_ms:0}}),0);
  assert.equal(holdPassage({alarm_enabled:true},{source_pts_ns:'1000000001'},
    {passage_observation:{pts:'1000000000'}}),false);
});
