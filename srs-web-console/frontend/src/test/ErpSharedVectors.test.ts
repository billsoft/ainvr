import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {unwrapErp,liftErp} from '@/features/erpGeometry';
const cases=JSON.parse(readFileSync('../../test/fixtures/erp-geometry-vectors.json','utf8'));
for(const c of cases)it('shared geometry: '+c.name,()=>{if(c.reject){expect(()=>unwrapErp(c.points)).toThrow();return;}const p=unwrapErp(c.points);p.forEach((v:number[],i:number)=>v.forEach((x,j)=>expect(x).toBeCloseTo(c.unwrapped[i][j],10)));liftErp(c.point,p).forEach((x,j)=>expect(x).toBeCloseTo(c.lifted[j],10));});
