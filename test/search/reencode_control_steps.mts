// Manual real-hardware phase. Never a test-double result or ordinary unit test.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { userInfo } from 'node:os';
import { SearchReencodeAiClient, type SearchReencodeRequest } from '../../srs-web-console/backend/src/services/searchReencodeAi.js';
import { limitedBytes } from '../../srs-web-console/backend/src/services/internalServiceHttp.js';

if(process.argv.length!==4||process.argv[2]!=='--run-hardware'||userInfo().username!=='sunrise')throw Error('explicit_sunrise_hardware_phase_required');
const root=realpathSync(new URL('../..',import.meta.url)), directory=realpathSync(resolve(process.argv[3]!));
const child=relative(resolve(root,'test/results/search-reencode-control'),directory);
if(!child||child.startsWith('..')||isAbsolute(child))throw Error('owned_test_directory_required');
const configFile=resolve(directory,'fixture-config.json'), status=statSync(configFile);
if((status.mode&0o777)!==0o600||status.uid!==process.getuid?.()||status.nlink!==1||status.size>4096)throw Error('private_fixture_config_required');
const config=JSON.parse(readFileSync(configFile,'utf8'));
if(config.schema_version!=='search-reencode-control-fixture-v1'||config.listen_port!==25442||!/^[a-f0-9]{48}$/.test(config.api_token))throw Error('invalid_fixture_config');
const inputs=JSON.parse(readFileSync(resolve(directory,'inputs.json'),'utf8'));
const pin=inputs.target;
if(pin.package_id!=='siglip2-base-full-int8'||pin.model_version!==`search-v1-${pin.package_sha256}`||!/^[a-f0-9]{64}$/.test(pin.package_sha256)||inputs.images.length!==2)throw Error('invalid_fixture_inputs');
const endpoint='http://127.0.0.1:25442', headers={'x-api-key':config.api_token};
const unavailable=await fetch(`${endpoint}/api/v1/search/reencode/capabilities`,{signal:AbortSignal.timeout(3000),redirect:'error'});
if(unavailable.status!==401)throw Error('unauthenticated_control_accepted');await unavailable.body?.cancel();
const response=await fetch(`${endpoint}/api/v1/search/reencode/capabilities`,{headers,signal:AbortSignal.timeout(3000),redirect:'error'});
const capability=JSON.parse((await limitedBytes(response,8192)).toString('utf8'));
if(!response.ok||capability.implemented!==true||capability.cpu_model_fallback!==false||capability.cpu_image_processing!==false||'ready'in capability)throw Error('invalid_hardware_capability');
const client=new SearchReencodeAiClient(async()=>({baseUrl:endpoint,apiToken:config.api_token,timeoutMs:30000}));
const images=[];
for(const source of inputs.images){
  if(!/^[a-z0-9_-]{1,40}\.jpg$/.test(source.file)||!/^[a-f0-9]{64}$/.test(source.sha256))throw Error('invalid_fixture_image_path');
  const image=readFileSync(resolve(directory,source.file));
  if(createHash('sha256').update(image).digest('hex')!==source.sha256)throw Error('fixture_image_changed');
  const request:SearchReencodeRequest={schema_version:'search-reencode-image-v1',request_id:randomUUID(),job_id:inputs.job_id,generation:1,
    payload_fingerprint:inputs.payload_fingerprint,target:pin,sample_id:source.sample_id,source_fingerprint:source.source_fingerprint,
    jpeg_sha256:source.sha256,expires_ms:Date.now()+29000};
  const began=performance.now(), result=await client.encode({request,dimensions:768,jpeg:image});
  if(result.image_width!==source.width||result.image_height!==source.height)throw Error('visible_jpeg_dimensions_changed');
  const vector=Buffer.alloc(result.vector.length*4);result.vector.forEach((value:number,index:number)=>vector.writeFloatLE(value,index*4));
  const name=source.file.replace('.jpg','.f32');writeFileSync(resolve(directory,name),vector,{flag:'wx',mode:0o600});
  images.push({name:source.file,jpeg_sha256:source.sha256,width:result.image_width,height:result.image_height,
    elements:result.dimensions,elapsed_ms:performance.now()-began,vector_sha256:createHash('sha256').update(vector).digest('hex'),
    l2_squared:result.vector.reduce((sum:number,value:number)=>sum+value*value,0),preprocessing_version:result.preprocessing_version});
}
const report={interface_passed:true,actual_node_client:true,actual_ai_http:true,actual_jpu_gles_bpu:true,
  software_license_oracle:true,production_license_verified:false,pg_authorization_verified:false,
  semantic_accuracy_verified:false,numeric_reference_passed:null,target:pin,images};
writeFileSync(resolve(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(report));
