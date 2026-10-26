// Authorized deployment only; never print or commit generated credentials.
import {randomBytes} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(process.env.AINVR_INSTALL_ROOT??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')); 
process.loadEnvFile(path.join(root,'deploy/s100p/runtime/backend.env'));
const {PgConfigStore}=await import(path.join(root,'srs-web-console/backend/dist/store/pgStore.js'));
const pg=new PgConfigStore({poolConfig:{host:process.env.CONFIG_PG_HOST,port:Number(process.env.CONFIG_PG_PORT??5432),user:process.env.CONFIG_PG_USER,password:process.env.CONFIG_PG_PASSWORD,database:process.env.CONFIG_PG_DATABASE},masterKeyPath:process.env.CONFIG_MASTER_KEY_PATH});
try{
 await pg.init();
 const old=await pg.getSecret('onvif/service-token'),token=old??randomBytes(32).toString('hex');
 if(!old)await pg.setSecret('onvif/service-token',token,'onvif-deployment');
 await mkdir('/etc/ainvr',{recursive:true});
 const target='/etc/ainvr/onvif-bootstrap.json';let installed;
 try{installed=JSON.parse(await readFile(target,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
 if(installed&&installed.token!==token)throw new Error('Service credential differs; explicit rotation required');
 if(!installed)await writeFile(target,JSON.stringify({listen:'127.0.0.1:8150',token})+'\n',{mode:0o600,flag:'wx'});
 console.log('ONVIF service credential provisioned; feature enablement unchanged.');
}finally{await pg.pool.end()}
