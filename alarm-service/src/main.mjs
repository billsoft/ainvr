import {createRecordingEvidence} from './recording-evidence.mjs';
import {createReviewTransport} from './review-transport.mjs';
import {createEvidenceSource} from './evidence-source.mjs';
import {loadConfig,startService} from './runtime.mjs';
import {loadBootstrap,createConfigTransport,ConfigCenterController} from './config-center.mjs';

let service;
try{
  if(process.argv.length===4&&process.argv[2]==='--config-center'){
    const bootstrap=await loadBootstrap(process.argv[3]);
    service=new ConfigCenterController({request:createConfigTransport(bootstrap),evidenceSource:createEvidenceSource(bootstrap),reviewInvoke:createReviewTransport(bootstrap),recoverEvidence:createRecordingEvidence(bootstrap)});
    service.run(bootstrap.poll_ms);
    process.stdout.write(JSON.stringify({event:'configuration_client_started',service:'alarm-service'})+'\n');
  }else{
    if(process.argv.length!==3)throw Error('Configuration file required');
    service=await startService(await loadConfig(process.argv[2]));
    process.stdout.write(JSON.stringify({event:'service_started',service:'alarm-service',instance_id:service.instanceId})+'\n');
  }
}catch{
  process.stderr.write(JSON.stringify({event:'startup_failed',service:'alarm-service',message:'Check private configuration, storage and listener availability'})+'\n');
  process.exitCode=1;
}
if(service){
  let stopping=false;
  const stop=async()=>{
    if(stopping)return;stopping=true;
    // Supervisor may force-stop; durable preparation allows the next instance to replay.
    const deadline=setTimeout(()=>process.exit(1),25000);deadline.unref();
    try{await service.close();clearTimeout(deadline);process.exitCode=0;}
    catch{process.exitCode=1;}
  };
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
