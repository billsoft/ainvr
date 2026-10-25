// Run only during an authorized deployment. Never print the service secrets.
import {randomBytes} from 'node:crypto';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
process.loadEnvFile(path.join(root,'deploy/s100p/runtime/backend.env'));
const {PgConfigStore}=await import(path.join(root,'srs-web-console/backend/dist/store/pgStore.js'));
const pg=new PgConfigStore({poolConfig:{host:process.env.CONFIG_PG_HOST,port:Number(process.env.CONFIG_PG_PORT??5432),user:process.env.CONFIG_PG_USER,password:process.env.CONFIG_PG_PASSWORD,database:process.env.CONFIG_PG_DATABASE},masterKeyPath:process.env.CONFIG_MASTER_KEY_PATH});
try{
 await pg.init();
 const existing=await pg.getSecret('gb28181/gateway-token');
 const token=existing??randomBytes(32).toString('hex');
 const media=await pg.getSecret('gb28181/media-secret')??randomBytes(32).toString('hex');
 // Persist generated identities first. An interrupted file write can then be
 // retried without generating a different token on the next installation.
 if(!existing)await pg.setSecret('gb28181/gateway-token',token,'gb-deployment');
 if(!await pg.hasSecret('gb28181/media-secret'))await pg.setSecret('gb28181/media-secret',media,'gb-deployment');
 await mkdir('/etc/ainvr',{recursive:true});
 const bootstrap='/etc/ainvr/gb28181-bootstrap.json';
 let installed;
 try{installed=JSON.parse(await readFile(bootstrap,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(installed&&installed.token!==token)throw new Error('Existing gateway credential differs; explicit credential rotation required');
 if(!installed)await writeFile(bootstrap,JSON.stringify({listen:'127.0.0.1:8096',token})+'\n',{mode:0o600,flag:'wx'});
 const mediaPath='/etc/ainvr/gb28181-media.ini';
 let mediaExists=true;try{await access(mediaPath);}catch{mediaExists=false;}
 if(mediaExists){const installedMedia=await readFile(mediaPath,'utf8');if(!installedMedia.split(/\r?\n/).includes(`secret=${media}`))throw new Error('Existing media credential differs; explicit credential rotation required');}
 if(!mediaExists){
  const content=`[api]\nsecret=${media}\n[general]\nlisten_ip=127.0.0.1\n[http]\nport=8097\nsslport=0\n[rtsp]\nport=8556\nsslport=0\n[rtmp]\nport=0\nsslport=0\n[rtp_proxy]\nport=0\n[srt]\nport=0\n[rtc]\nport=0\ntcpPort=0\nenableTurn=0\n[onvif]\nport=0\n[shell]\nport=0\n[hook]\nenable=0\n[protocol]\nenable_mp4=0\nenable_hls=0\nenable_hls_fmp4=0\nenable_rtmp=1\nenable_rtsp=1\n`;
  await writeFile(mediaPath,content,{mode:0o600,flag:'wx'});
 }
 console.log('Gateway credentials provisioned; platform enablement unchanged.');
}finally{await pg.pool.end();}
