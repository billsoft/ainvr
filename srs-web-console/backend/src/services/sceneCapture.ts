import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {jpegDimensions} from './searchContract.js';
import {endpoint,limitedBytes,type InternalServiceConnection} from './internalServiceHttp.js';
const run=promisify(execFile);
export interface SceneImage {
 bytes:Buffer;w:number;h:number;
 /** Receiver remux completion, NOT a source exposure timestamp. */
 at:Date;
 timing?:{basis:'receiver-wallclock';startedAt:Date;receivedAt:Date;packetPtsSeconds:number;sourceFreshness:'unverified'};
}
export interface CaptureContext {app:string;stream:string;width:number;height:number}
async function hardwareTool(){
 const configured=process.env.AINVR_RECORDING_FRAME_TOOL;
 const suffix='deploy/s100p/bin/ainvr_recording_frame';
 const paths=configured?[configured]:[resolve(fileURLToPath(new URL('../../../../',import.meta.url)),suffix),
  '/home/sunrise/ainvr/'+suffix];
 for(const path of paths){if(!path.startsWith('/'))continue;try{await access(path,1);return path;}catch{}}
 throw Error('scene_hardware_unavailable');
}
export async function sceneCaptureAvailable(){
 try{await Promise.all([hardwareTool(),access('/opt/ainvr/ffmpeg-8.1.2/bin/ffmpeg',1),access('/opt/ainvr/ffmpeg-8.1.2/bin/ffprobe',1)]);return true;}
 catch{return false;}
}
// Remux compressed packets on tmpfs. The existing recorder VPU / GLES / JPU
// exact-packet extractor owns all decoding, colour conversion, scaling and JPEG.
let capturing=false;
export async function captureScene(ctx:CaptureContext):Promise<SceneImage>{
 if(capturing)throw Error('scene_capture_busy');
 if(![ctx.app,ctx.stream].every(s=>/^[A-Za-z0-9_.-]{1,128}$/.test(s)&&s!=='.'&&s!=='..'))throw Error('scene_source_invalid');
 capturing=true;
 let dir:string|undefined;
 try{
  const helper=await hardwareTool();
  dir=await mkdtemp('/dev/shm/ainvr-scene-');
  const file=join(dir,'capture.mp4'),picture=join(dir,'frame.jpg'),bin='/opt/ainvr/ffmpeg-8.1.2/bin/';
  const started=Date.now();
  await run(bin+'ffmpeg',['-nostdin','-loglevel','error','-rw_timeout','3000000','-use_wallclock_as_timestamps','1',
   '-analyzeduration','250000','-probesize','262144','-i','rtmp://127.0.0.1/'+ctx.app+'/'+ctx.stream,
   '-map','0:v:0','-an','-c:v','copy','-t','2.5','-fs','8388608',file],{timeout:8500,killSignal:'SIGKILL',maxBuffer:16384});
  const at=new Date();
  if(at.getTime()-started<2100)throw Error('scene_cached_video');
  const probe=await run(bin+'ffprobe',['-v','error','-select_streams','v:0','-show_entries',
   'stream=width,height:packet=pos,pts_time','-of','json',file],{timeout:1500,maxBuffer:131072});
  const info=JSON.parse(probe.stdout),packets=info.packets as {pos:string;pts_time:string}[];
  const packet=packets?.at(-1);
  const pts=Number(packet?.pts_time);
  if(info.streams?.length!==1||info.streams[0].width!==ctx.width||info.streams[0].height!==ctx.height||
    !packet||typeof packet.pts_time!=='string'||!packet.pts_time.trim()||!Number.isFinite(pts)||pts<2||!/^\d+$/.test(packet.pos))throw Error('scene_capture_incomplete');
  await run(helper,[file,packet.pos,packet.pts_time,picture],{timeout:8500,killSignal:'SIGKILL',maxBuffer:65536});
  const bytes=await readFile(picture),size=jpegDimensions(bytes);
  if(!size||bytes.length>1875000||size.width*ctx.height!==size.height*ctx.width)throw Error('scene_capture_geometry');
  // Wall-clock timestamps reject an instant cache burst only. Old packets
  // paced over time and frozen/re-encoded pixels remain indistinguishable
  // without a trusted source session/frame/exposure-time protocol. Neither
  // JPEG equality nor inequality establishes freshness.
  return {bytes,w:size.width,h:size.height,at,timing:{basis:'receiver-wallclock',startedAt:new Date(started),
   receivedAt:at,packetPtsSeconds:pts,sourceFreshness:'unverified'}};
 }finally{try{if(dir)await rm(dir,{recursive:true,force:true});}finally{capturing=false;}}
}
export async function matchScene(connection:InternalServiceConnection,reference:Buffer,current:SceneImage){
 const size=jpegDimensions(reference);
 if(!size||size.width*current.h!==size.height*current.w)throw Error('scene_aspect_changed');
 const response=await fetch(endpoint(connection,'/internal/ptz/scene-match'),{
  method:'POST',redirect:'error',signal:AbortSignal.timeout(connection.timeoutMs),
  headers:{'content-type':'application/json','x-service-token':connection.apiToken},
  body:JSON.stringify({frame0:reference.toString('base64'),frame1:current.bytes.toString('base64')})
 });
 if(!response.ok){await response.body?.cancel();throw Error('scene_match_unavailable');}
 return JSON.parse((await limitedBytes(response,16384)).toString()) as unknown;
}
