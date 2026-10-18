/** Export actual point/SEI UI modules for an isolated real-browser Canvas check.
 * No app deployment,model inference,camera,or production configuration changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const root = '/home/sunrise/ainvr';
const frontend = path.join(root, 'srs-web-console/frontend');
const out = path.join(root, 'out/build/locateanything-browser-point-fixture-v1');
const require = createRequire(path.join(frontend, 'package.json'));
const ts = require('typescript');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
if (fs.existsSync(out)) throw new Error('New output directory required');
const contract = JSON.parse(fs.readFileSync(path.join(root, 'test/results/locateanything-point-sei-contract-validation-v1.json')));
const modules = {
  groundingPoints: 'src/components/player/groundingPoints.ts',
  seiDetections: 'src/components/player/seiDetections.ts',
  overlayGeometry: 'src/components/player/overlayGeometry.ts',
  panoramaDetection: 'src/components/player/panoramaDetection.ts',
  recordingSei: 'src/pages/Playback/recordingSei.ts',
};
const sourceHashes = {};
fs.mkdirSync(out, { recursive: true });
for (const [name, relative] of Object.entries(modules)) {
  const source = fs.readFileSync(path.join(frontend, relative));
  const key = 'srs-web-console/frontend/' + relative;
  sourceHashes[key] = sha(source);
  if (contract.source_sha256[key] && contract.source_sha256[key] !== sha(source)) {
    throw new Error('Actual source changed since contract check: ' + key);
  }
  let js = ts.transpileModule(source.toString(), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    fileName: relative,
  }).outputText;
  js = js.replaceAll("'./groundingPoints'", "'./groundingPoints.js'")
    .replaceAll("'@/components/player/seiDetections'", "'./seiDetections.js'");
  if (/from ['"][@/]/.test(js)) throw new Error('Unresolved runtime import: ' + name);
  fs.writeFileSync(path.join(out, name + '.js'), js);
}
const fixture = fs.readFileSync(path.join(root, 'test/results/locateanything-point-sei-fixtures-v1.json'));
if (sha(fixture) !== contract.fixture_sha256) throw new Error('C++ fixture changed');
fs.writeFileSync(path.join(out, 'fixtures.json'), fixture);
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>AINVR point renderer contract fixture</title>
<style>body{margin:24px;background:#101827;color:#e5e7eb;font:16px sans-serif}h1{font-size:24px;margin:0 0 8px}p{margin:8px 0}.grid{display:grid;grid-template-columns:640px 640px;gap:20px}.scene{background:#192334;padding:10px}canvas{display:block;background:#263447;margin-top:8px}pre{white-space:pre-wrap}#result{color:#8ce99a}</style>
<h1>AINVR 定位点浏览器绘制检查</h1>
<p>使用实际前端函数与 C++ SEI 测试载荷；合成画布，不代表模型识别或真实视频链路。</p>
<p id="result">RUNNING</p><div class="grid">
<div class="scene">4K 画面按比例显示（上下留白）<canvas id="flat" width="640" height="480"></canvas></div>
<div class="scene">竖屏画面按比例显示（左右留白）<canvas id="portrait" width="640" height="480"></canvas></div>
<div class="scene">超预算点数保留及提示<canvas id="budget" width="640" height="360"></canvas></div>
<div class="scene">ERP 前半球点可见，背面点不显示<canvas id="erp" width="640" height="360"></canvas></div>
</div><pre id="evidence"></pre><script type="module" src="./check.js"></script></html>`;
fs.writeFileSync(path.join(out, 'index.html'), html);
const check = String.raw`import { drawGroundingPoints } from './groundingPoints.js';
import { computeContainLayout } from './overlayGeometry.js';
import { extractSeiDetections, SeiFrameCache } from './seiDetections.js';
import { drawPanoramaDetections } from './panoramaDetection.js';
import { parseRecordingSei, pickRecordingSei } from './recordingSei.js';
const checks=[];
const assert=(condition,name)=>{checks.push({name,passed:!!condition});if(!condition)throw Error(name)};
const bytes=hex=>Uint8Array.from(hex.match(/../g).map(x=>parseInt(x,16)));
const context=id=>document.getElementById(id).getContext('2d',{willReadFrequently:true});
const pixel=(ctx,x,y)=>Array.from(ctx.getImageData(x,y,1,1).data);
const green=(ctx,x,y)=>{const p=pixel(ctx,x,y);return p[1]>150&&p[0]<80&&p[2]<130&&p[3]>200};
const transparent=(ctx,x,y,w,h)=>{const a=ctx.getImageData(x,y,w,h).data;for(let i=3;i<a.length;i+=4)if(a[i])return false;return true};
try {
 const fixtures=(await(await fetch('./fixtures.json')).json()).fixtures;
 const fixture=(codec,kind)=>fixtures.find(x=>x.codec===codec&&x.kind===kind);
 for(const f of fixtures){const p=extractSeiDetections(bytes(f.annexb_hex));assert(p?.ptsNs===123000000,'C++ bytes '+f.codec+'/'+f.kind);}
 const point=extractSeiDetections(bytes(fixture('h264','point').annexb_hex));
 const clear=extractSeiDetections(bytes(fixture('h265','clear').annexb_hex));
 assert(point.detections.length===0&&point.grounding.points.length===1,'point is not a fake box');
 const flat=context('flat'),layout=computeContainLayout(3840,2160,640,480);
 drawGroundingPoints(flat,point.grounding,layout);
 assert(green(flat,320,150),'4K point center pixels at 320,150');
 assert(transparent(flat,0,0,640,60)&&transparent(flat,0,420,640,60),'4K letterbox untouched');
 const portrait=context('portrait'),pLayout=computeContainLayout(2160,3840,640,480);
 drawGroundingPoints(portrait,point.grounding,pLayout);
 assert(green(portrait,320,120),'portrait point center pixels at 320,120');
 assert(transparent(portrait,0,0,185,480)&&transparent(portrait,455,0,185,480),'portrait sidebars untouched');
 const budget=extractSeiDetections(bytes(fixture('h264','budget').annexb_hex));
 const bctx=context('budget');drawGroundingPoints(bctx,budget.grounding,computeContainLayout(3840,2160,640,360));
 assert(budget.grounding.points.length+budget.grounding.omitted===40&&budget.grounding.omitted>0,'budget loss explicitly counted');
 assert(!transparent(bctx,10,8,220,18),'budget notice produced actual pixels');
 const erp=context('erp'),camera={view:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],projection:[1,0,0,0,0,1,0,0,0,0,-1.002,-1,0,0,-.2,0]};
 drawPanoramaDetections(erp,[],camera,640,360,3840,1920,{points:[{x:.25,y:.5,class_name:'',confidence:null}],omitted:0});
 assert(transparent(erp,0,0,640,360),'ERP back hemisphere paints no marker');
 drawPanoramaDetections(erp,[],camera,640,360,3840,1920,{points:[{x:.75,y:.5,class_name:'',confidence:null}],omitted:0});
 assert(green(erp,320,180),'ERP front point center pixels at 320,180');
 const cache=new SeiFrameCache();cache.put(90000,point);assert(cache.getForDisplay(117000)?.grounding.points.length===1&&cache.getForDisplay(117001)===null,'live 300ms frame expiry');cache.put(100000,clear);assert(cache.getForDisplay(101000)?.grounding.points.length===0,'live explicit clear');
 const recorded=parseRecordingSei({frames:[{timeMs:1000,payload:fixture('h264','point').payload},{timeMs:2000,payload:fixture('h265','clear').payload}]});
 assert(pickRecordingSei(recorded,999)===null&&pickRecordingSei(recorded,1301)===null,'playback past-only expiry');
 const empty=document.createElement('canvas');empty.width=640;empty.height=480;const ectx=empty.getContext('2d');drawGroundingPoints(ectx,pickRecordingSei(recorded,2000).grounding,layout);assert(transparent(ectx,0,0,640,480),'playback clear paints no stale marker');
 const edge=document.createElement('canvas');edge.width=640;edge.height=480;const edgeCtx=edge.getContext('2d');drawGroundingPoints(edgeCtx,{points:[{x:0,y:0,class_name:'edge',confidence:null}],omitted:0},layout);assert(transparent(edgeCtx,0,0,640,60),'edge marker clipped to video content');
 const result={status:'passed',scope:'Real browser actual Canvas/helper and C++ bytes only;not full app/camera/model acceptance',neural_calls:0,checks,canvas_api_mocked:false,browser:navigator.userAgent,full_app_render_verified:false,real_camera_srs_verified:false};
 document.getElementById('result').textContent='PASS · '+checks.length+' checks';document.getElementById('evidence').textContent=JSON.stringify(result,null,2);document.body.dataset.status='passed';
} catch(error) {document.body.dataset.status='failed';document.getElementById('result').textContent='FAILED: '+error.message;document.getElementById('evidence').textContent=JSON.stringify({status:'failed',checks,error:error.stack},null,2)}
`;
fs.writeFileSync(path.join(out, 'check.js'), check);
const files = {};
for (const name of fs.readdirSync(out)) files[name] = sha(fs.readFileSync(path.join(out, name)));
const manifest={scope:'Export of actual point renderer modules;not a model or app deployment',source_sha256:sourceHashes,fixture_sha256:sha(fixture),files,preparer_sha256:sha(fs.readFileSync(new URL(import.meta.url)))};
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({status:'prepared',out,files:Object.keys(files),manifest_sha256:sha(fs.readFileSync(path.join(out,'manifest.json')))}));
