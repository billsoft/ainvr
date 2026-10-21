import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {unwrapErp,liftErp} from '../src/erp-geometry.mjs';
const cases=JSON.parse(readFileSync(new URL('../../test/fixtures/erp-geometry-vectors.json',import.meta.url),'utf8'));
for(const c of cases)test('shared geometry: '+c.name,()=>{if(c.reject){assert.throws(()=>unwrapErp(c.points));return;}const p=unwrapErp(c.points);p.forEach((v,i)=>v.forEach((x,j)=>assert.ok(Math.abs(x-c.unwrapped[i][j])<1e-10)));liftErp(c.point,p).forEach((x,j)=>assert.ok(Math.abs(x-c.lifted[j])<1e-10));});
