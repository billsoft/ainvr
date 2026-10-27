import { defineConfig } from '../../srs-web-console/frontend/node_modules/vite/dist/node/index.js';
import react from '../../srs-web-console/frontend/node_modules/@vitejs/plugin-react/dist/index.js';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../..'),front=path.join(root,'srs-web-console/frontend');
export default defineConfig({root:import.meta.dirname,plugins:[react()],resolve:{alias:{'@':path.join(front,'src'),'react':path.join(front,'node_modules/react'),'react-dom':path.join(front,'node_modules/react-dom'),'react-router-dom':path.join(front,'node_modules/react-router-dom')}},css:{postcss:front},server:{host:'127.0.0.1',port:28089,strictPort:true,fs:{allow:[root]},proxy:{'/api':'http://127.0.0.1:28088','/__fixture':'http://127.0.0.1:28088','/media':'http://127.0.0.1:28088'}}});
