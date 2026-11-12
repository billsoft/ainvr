import {it,expect} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createVehicleArtifactReader} from '../services/vehicleArtifacts.js';
it('distinguishes file integrity from runtime readiness, and invalidates changed files',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'vehicle-artifact-'));
 try{
  const read=createVehicleArtifactReader(directory);
  expect((await read()).map(r=>r.state)).toEqual(['missing','missing','missing']);
  const file='plate-detect-yolo26s.hbm',bytes=Buffer.from('fixture, never an actual model');
  await writeFile(path.join(directory,file),bytes);
  await writeFile(path.join(directory,file+'.ainvr.json'),JSON.stringify({schema_version:1,target:'rdk_s100p',hbm_file:file,hbm_bytes:bytes.length,hbm_sha256:createHash('sha256').update(bytes).digest('hex'),accuracy_verified:false}));
  expect((await read())[0]).toMatchObject({state:'verified_file',accuracy_verified:false,adapter_integrated:false});
  await writeFile(path.join(directory,file),Buffer.alloc(bytes.length,42));
  expect((await read())[0].state).toBe('invalid');
 }finally{await rm(directory,{recursive:true,force:true})}
});
