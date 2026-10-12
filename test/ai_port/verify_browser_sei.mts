// Copyright AINVR. Feed real SRS output NALs into the production browser parser.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {inspectSeiDetections} from '../../srs-web-console/frontend/src/components/player/seiDetections.ts';
assert.equal(process.argv.length,4,'Usage: node verify_browser_sei.mts transport_report.json new_browser_report.json');
assert.equal(existsSync(process.argv[3]),false,'Output already exists');
const report=JSON.parse(readFileSync(process.argv[2],'utf8'));
assert.equal(report.passed,true);
const samples=report.output_evidence.samples;
assert.ok(samples.length>=1);
for(const sample of samples){
 const bytes=new Uint8Array(Buffer.from(sample.sei_nal_hex,'hex'));
 const parsed=inspectSeiDetections(bytes);
 assert.equal(parsed.present,true,'Real encoded SEI UUID must survive emulation-prevention escaping');
 assert.ok(parsed.result);
 assert.equal(parsed.result.ptsNs,sample.metadata.pts);
 assert.equal(parsed.result.ageMs,sample.metadata.age_ms);
 assert.deepEqual(parsed.result.detections,[]);
}
writeFileSync(process.argv[3],JSON.stringify({passed:true,real_srs_samples_parsed:samples.length,
 production_browser_parser_used:true,actual_browser_playback_verified:false},null,2));
console.log('Production browser parser accepted',samples.length,'real SRS output samples');
