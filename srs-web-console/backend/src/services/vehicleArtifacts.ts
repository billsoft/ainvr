import {stat,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const names=['plate-detect-yolo26s.hbm','plate-recog-color.hbm','plate-recog-lprnet.hbm'] as const;
const defaultDirectory=fileURLToPath(new URL('../../../../ai-service/models/derived/s100p/',import.meta.url));
export interface VehicleArtifact {file:string;state:'verified_file'|'missing'|'invalid';accuracy_verified:boolean;adapter_integrated:false;sha256?:string}
/** File integrity only, never a substitute for adapter/accuracy/runtime validation. */
export function createVehicleArtifactReader(directory=defaultDirectory){
  const cache=new Map<string,{stamp:string;result:VehicleArtifact}>();
  let pending:Promise<VehicleArtifact[]>|null=null;
  const scan=async()=>Promise.all(names.map(async file=>{
    const model=path.join(directory,file),contract=model+'.ainvr.json';
    const invalid:VehicleArtifact={file,state:'invalid',accuracy_verified:false,adapter_integrated:false};
    try{
      const [m,c]=await Promise.all([stat(model,{bigint:true}),stat(contract,{bigint:true})]);
      if(!m.isFile()||!c.isFile()||m.size<=0n||m.size>128n*1024n*1024n||c.size>65536n)return invalid;
      const fingerprint=(s:typeof m)=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');
      const stamp=fingerprint(m)+'/'+fingerprint(c),old=cache.get(file);if(old?.stamp===stamp)return old.result;
      const document=JSON.parse(await readFile(contract,'utf8'));
      if(document.hbm_file!==file||document.hbm_bytes!==Number(m.size)||!/^([a-f0-9]{64})$/.test(document.hbm_sha256)||document.schema_version!==1||document.target!=='rdk_s100p')return invalid;
      const digest=createHash('sha256').update(await readFile(model)).digest('hex');
      const [afterM,afterC]=await Promise.all([stat(model,{bigint:true}),stat(contract,{bigint:true})]);
      if(digest!==document.hbm_sha256||fingerprint(afterM)+'/'+fingerprint(afterC)!==stamp)return invalid;
      const result:VehicleArtifact={file,state:'verified_file',accuracy_verified:document.accuracy_verified===true,adapter_integrated:false,sha256:digest};cache.set(file,{stamp,result});return result;
    }catch(e){return {...invalid,state:(e as NodeJS.ErrnoException).code==='ENOENT'?'missing':'invalid'} as VehicleArtifact}
  }));
  return ()=>pending??(pending=scan().finally(()=>{pending=null}));
}
