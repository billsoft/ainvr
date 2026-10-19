"""Link the 27 qk16x16/sv16x16 INT8-weight MoonViT probe HBOs (opt0) into one all27 HBM for board evaluation.

Research candidate only. Checks each block status/BPU placement, links with the official
Model.link_models, disassembles and writes a board manifest. No deployed artifact is touched.
"""
from pathlib import Path
import os,sys,json,time,hashlib,subprocess
for k in ['DEV_B30_TRITON_VPU','DEV_B30_ENABLE_VPU_EXTRA_OP','DEV_B30_ENABLE_VPU_TRIAL_OP']:os.environ[k]='1'
BASE=Path('/opt/locate-oellm-research-v1');SDK=BASE/'sdk448-isolated/python';sys.path.insert(0,str(SDK));sys.path.insert(0,str(BASE/'leap-source-overlay'))
from hbdk4.compiler.hbm import Hbo
from leap_llm.nn.utils import Model
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
ROOT=Path('/opt/locate-vision-recipe-probe-v296');OUT=Path('/work/official-llm-v1/vision-all27-qk16sv16-o0-v296-board-package');assert not OUT.exists()
roots=[ROOT/f'block{i}-qk16x16-sv16x16' for i in range(27)];comps=[]
for i,p in enumerate(roots):
 s=json.loads((p/'status.json').read_text());assert s['status']=='compiled_bpu_only' and s['bpu_only'] and s['stage']==i and sha(p/'model.hbm')==s['hbm_sha256']
 comps.append(dict(stage=i,status_sha256=sha(p/'status.json'),converted_bc_sha256=s['converted_bc_sha256'],hbo_sha256=sha(p/'model.hbo'),recipe=s['activation_recipe']))
OUT.mkdir();(OUT/'official-q8').mkdir()
Model.link_models([Hbo(str(p/'model.hbo')) for p in roots],str(OUT/'official-q8/model.hbm'))
d=json.loads(subprocess.check_output([str(SDK/'hbdk4/compiler/_mlir_libs/hbrt4-disas'),'--json',str(OUT/'official-q8/model.hbm')],text=True))
assert len(d['graphs'])==27 and all(g['nodes'] and all(n['device']=='DEVICE_CATEGORY_BPU' for n in g['nodes']) for g in d['graphs'])
(OUT/'disas.json').write_text(json.dumps(d,indent=2)+'\n')
programs=[]
for i,p in enumerate(roots):
 ports=json.loads((p/'ports.json').read_text());name=f'locate_official_moonvit_block{i}_w8';assert name in {g['name'] for g in d['graphs']}
 programs.append(dict(name=name,inputs=ports['inputs'],outputs=ports['outputs']))
files={n:dict(bytes=(OUT/n).stat().st_size,sha256=sha(OUT/n)) for n in ['official-q8/model.hbm','disas.json']}
m=dict(schema='locateanything_vision_recipe_board_v296',recipe='INT8 per-channel weights;linear A16;qk16x16;sv16x16;softmax16;opt0',components=comps,programs=programs,files=files,whole_model_verified=False,release_approved=False,created=time.time())
(OUT/'manifest.json').write_text(json.dumps(m,indent=2)+'\n')
print(json.dumps(dict(status='linked',hbm_sha256=files['official-q8/model.hbm']['sha256'],hbm_bytes=files['official-q8/model.hbm']['bytes'],manifest_sha256=sha(OUT/'manifest.json'))))
