import {test} from 'node:test';
import assert from 'node:assert/strict';
import {measuredCoverage} from '../src/flow-statistics.mjs';
const at=n=>new Date(n).toISOString();
test('overlapping segments clipped and counted once',()=>{
 const c=measuredCoverage([{from:at(-100),to:at(3000)},{from:at(2000),to:at(7000)},{from:at(5000),to:at(12000)}],at(0),at(10000));
 assert.equal(c.expected_ms,10000);assert.equal(c.covered_ms,10000);assert.equal(c.ratio,1);
 assert.deepEqual(c.intervals,[{from:at(0),to:at(10000)}]);
});
test('boundary grace is not measured observation',()=>{
 const c=measuredCoverage([{from:at(2000),to:at(8000)}],at(0),at(10000),{start_ms:3000,end_ms:3000});
 assert.equal(c.state,'complete');assert.equal(c.covered_ms,6000);assert.equal(c.ratio,.6);assert.equal(c.tolerated_ms,4000);
});
test('no coverage means measured zero and no_data',()=>{
 const c=measuredCoverage([],at(0),at(10000));
 assert.equal(c.state,'no_data');assert.equal(c.ratio,0);assert.equal(c.tolerated_ms,0);
});
test('separate gaps survive the existing continuity tolerance',()=>{
 const c=measuredCoverage([{from:at(0),to:at(2000)},{from:at(6000),to:at(10000)}],at(0),at(10000));
 assert.equal(c.state,'partial');assert.equal(c.covered_ms,6000);
 assert.deepEqual(c.gaps,[{from:at(2000),to:at(6000)}]);
});

test('continuity tolerance does not invent measured time across a small hole',()=>{
 const c=measuredCoverage([{from:at(0),to:at(4000)},{from:at(5000),to:at(10000)}],at(0),at(10000));
 assert.equal(c.state,'complete');assert.equal(c.covered_ms,9000);assert.equal(c.ratio,.9);assert.equal(c.tolerated_ms,1000);
 assert.equal(c.intervals.length,2);
});
