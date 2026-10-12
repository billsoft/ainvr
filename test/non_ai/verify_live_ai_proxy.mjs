// AINVR: real AI upstream through the production BFF route implementation.
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require=createRequire(root+'/srs-web-console/backend/package.json');
const Fastify=require('fastify');
const {aiProxyRoutes}=await import(root+'/srs-web-console/backend/dist/routes/aiProxy.js');
const config=JSON.parse(await readFile(root+'/deploy/s100p/runtime/ai-service.json','utf8'));
const app=Fastify();
await app.register(aiProxyRoutes,{prefix:'/api',fallbackBaseUrl:'http://127.0.0.1:8000',
 settingsStore:{read:async()=>({aiService:{baseUrl:'',apiKey:config.server.api_key}})},
 srsClient:{}});
const evidence=[];
try {
 for(const url of ['/api/ai/health','/api/ai/channels']) {
  const response=await app.inject({url,headers:{'accept-encoding':'gzip, br'}});
  if(response.statusCode!==200)throw new Error(url+' status '+response.statusCode);
  if(response.headers['content-encoding'])throw new Error('Unexpected compressed body');
  const body=response.json();
  if(url.endsWith('/channels')&&!Array.isArray(body.channels))throw new Error('Invalid channels contract');
  evidence.push({url,status:response.statusCode,json:true,uncompressed:true});
 }
 await writeFile(root+'/test/results/live-ai-proxy.json',JSON.stringify({scope:'Production route implementation and real upstream; browser login excluded',evidence},null,2));
 console.log(JSON.stringify(evidence));
} finally {await app.close();}
