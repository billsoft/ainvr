import os,json,time,hashlib,traceback,subprocess
from pathlib import Path
for k in ['DEV_B30_TRITON_VPU','DEV_B30_ENABLE_VPU_EXTRA_OP','DEV_B30_ENABLE_VPU_TRIAL_OP']:os.environ[k]='1'
from hbdk4.compiler import load,compile,link
r=Path('/opt/locate-oellm-research-v1/original-decoder-stack-36-v6');bc=r/'stack-converted.bc';out={'status':'loading_saved_bc','pid':os.getpid(),'started':time.time(),'scope':'all36 original decoder layers+final norm AR1 only, saved converted BC; not full multimodal or board proof','board_calls':0,'jobs':1,'layer_count':36,'original_final_norm_included':True}
def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for chunk in iter(lambda:f.read(4*1024**2),b''):h.update(chunk)
 return h.hexdigest()
def store():(r/'savedcompile-v1.json').write_text(json.dumps(out,indent=2))
store()
try:
 source=json.loads((r/'status.json').read_text());assert len(source['layers'])==36 and source['original_final_norm_included'];assert bc.stat().st_size==2830972351
 out['converted_bc_sha256']=digest(bc);out['converted_bc_bytes']=bc.stat().st_size;out['status']='compiling';store()
 model=load(str(bc));hbo=compile(model,str(r/'stack-saved-v1.hbo'),march='nash-m',opt=0,jobs=1);out['status']='linking';store();link([hbo],str(r/'stack-saved-v1.hbm'))
 data=json.loads(subprocess.check_output(['/usr/local/lib/python3.10/dist-packages/hbdk4/compiler/_mlir_libs/hbrt4-disas','--json',str(r/'stack-saved-v1.hbm')],text=True));(r/'savedcompile-disas-v1.json').write_text(json.dumps(data));out.update(status='completed',hbm_sha256=digest(r/'stack-saved-v1.hbm'),hbm_file='stack-saved-v1.hbm',hbm_bytes=(r/'stack-saved-v1.hbm').stat().st_size,devices=[n['device'] for g in data['graphs'] for n in g['nodes']])
except BaseException:out.update(status='failed',error=traceback.format_exc())
out['finished']=time.time();store()
