// When the AI cache refuses frames (its memory spool is full), alarms publish without a
// screenshot. That used to be visible only as a counter in cache-status.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import {SpoolRefusalWatch} from '../src/review-spool-watch.mjs';

test('frames refused by the review frame spool are reported once a minute with their count',async()=>{
 let now=0,status={failed:3,dropped:1,cached_bytes:10,max_bytes:20,spool_free_bytes:5};const records=[];
 const watch=new SpoolRefusalWatch({read:async()=>JSON.stringify(status),clock:()=>now,emit:r=>records.push(r)});
 await watch.check();assert.equal(records.length,0,'first sight is the baseline, not a refusal');
 status={...status,failed:3};now=60000;await watch.check();assert.equal(records.length,0,'nothing new');
 status={...status,failed:10,dropped:2};now=90000;await watch.check();assert.equal(records.length,0,'at most once a minute');
 now=120000;await watch.check();
 assert.deepEqual(records,[{kind:'review_frame_spool_refused',failed:7,dropped:1,cached_bytes:10,max_bytes:20,spool_free_bytes:5,at:new Date(120000).toISOString()}]);
 status={...status,failed:2,dropped:0};now=180000;await watch.check();assert.equal(records.length,1,'AI service restarted: counters reset, new baseline');
 status={...status,failed:4};now=240000;await watch.check();assert.equal(records.at(-1).failed,2);
});

test('an unreadable status never throws',async()=>{
 const watch=new SpoolRefusalWatch({read:async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});},clock:()=>0,emit:()=>assert.fail('no record')});
 await watch.check();
 const garbage=new SpoolRefusalWatch({read:async()=>'{',clock:()=>60000,emit:()=>assert.fail('no record')});
 await garbage.check();
});
