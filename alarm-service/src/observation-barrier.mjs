// One repository is owned by one service process. Durable leases and pending
// outcomes are checked separately while this local writer barrier is held.
import {fail} from './domain.mjs';
const barriers=new WeakMap();
export function observationBarrier(repository){
  let barrier=barriers.get(repository);
  if(barrier)return barrier;
  let active=0,closing=false,configuring=false,wake;
  barrier={
    // Serialize snapshot publication and history maintenance, without blocking
    // observations during database deletion. The service has one repository owner.
    async configure(action){
      if(configuring)fail('consumer_busy','Configuration maintenance in progress; retry',503);
      configuring=true;
      try{return await action();}finally{configuring=false;}
    },
    enter(){
      if(closing)fail('consumer_busy','History maintenance in progress; retry same input',503);
      active++;
      let released=false;
      return ()=>{if(!released){released=true;active--;if(!active)wake?.();}};
    },
    async drain(action,timeoutMs=2000){
      if(closing)fail('consumer_busy','History maintenance in progress',503);
      closing=true;
      let timer;
      try{
        if(active)await new Promise((resolve,reject)=>{
          wake=resolve;
          timer=setTimeout(()=>{try{fail('consumer_busy','Observations still processing; retry deletion',503);}catch(error){reject(error);}},timeoutMs);
        });
        return await action();
      }finally{clearTimeout(timer);wake=undefined;closing=false;}
    }
  };
  barriers.set(repository,barrier);
  return barrier;
}
