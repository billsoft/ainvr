import Fastify from 'fastify';
import {it,expect,vi} from 'vitest';
import {observabilityRoutes} from '../routes/observability.js';
vi.mock('../services/restartHelperClient.js',()=>({restartHelperConfigFromEnv:()=>({baseUrl:'http://127.0.0.1:9188',token:'test-only-token'}),triggerShutdown:vi.fn(),getShutdownStatus:vi.fn()}));
it('forwards installed-service log identities but rejects arbitrary unit names before contacting the host',async()=>{
 const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(JSON.stringify({items:[],truncated:false,nextCursor:null}),{status:200,headers:{'content-type':'application/json'}}));
 const app=Fastify();await app.register(observabilityRoutes,{pgStore:null});
 try{
  for(const source of ['alarm-service','search-service','onvif']){
   expect((await app.inject('/observability/logs?source='+source)).statusCode).toBe(200);
   expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:9188/observe/logs?source='+source,expect.anything());
  }
  expect((await app.inject('/observability/logs?source=arbitrary-service')).statusCode).toBe(400);
  expect(fetcher).toHaveBeenCalledTimes(3);
 }finally{await app.close();fetcher.mockRestore();}
});
