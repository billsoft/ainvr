"""AINVR resume text candidate after quantization; never recalibrates."""
import argparse,hashlib,json,time
from pathlib import Path
import onnx
from hbdk4.compiler.onnx import export
from hbdk4.compiler import convert,compile,save as save_bc
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--ptq',type=Path,required=True)
p.add_argument('--expected-sha256',required=True)
p.add_argument('--output',type=Path,required=True)
p.add_argument('--jobs',type=int,default=4)
p.add_argument('--opt',type=int,choices=[0,1,2],default=2)
a=p.parse_args();assert 1<=a.jobs<=8
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(a.ptq)==a.expected_sha256;a.output.mkdir(exist_ok=False)
r={'state':'exporting','started_unix':time.time(),'ptq_sha256':a.expected_sha256,
   'target':'nash-m','jobs':a.jobs,'opt':a.opt,'calibration_repeated':False,
   'production_approved':False,'accuracy_verified':False,
   'scope':'MobileCLIP2 text encoder before RepRTA; preserved 512-phrase quantization'}
def save(): (a.output/'status.json').write_text(json.dumps(r,indent=2))
save()
try:
    module=export(proto=onnx.load(str(a.ptq)),name='mobileclip2_text')
    save_bc(module,str(a.output/'exported.bc'));r['state']='converting';save()
    module=convert(module,march='nash-m',advice=True,advice_path=str(a.output)+'/')
    ops=json.loads((a.output/'mobileclip2_text_advice.json').read_text());cpu=[x for x in ops if x['backend']=='external_cpu']
    rejected=[x for x in cpu if x['op_name'] not in ['/ArgMax','exact_token_cast_for_eot']]
    r.update(external_cpu_ops=cpu,cpu_neural_fallback_rejected_ops=rejected);save()
    assert ops and not rejected,'Neural CPU fallback rejected'
    save_bc(module,str(a.output/'quantized.bc'));r.update(state='compiling',bc_sha256=sha(a.output/'quantized.bc'));save()
    compile(module,str(a.output/'mobileclip2-text.hbm'),march='nash-m',opt=a.opt,jobs=a.jobs,debug=False,progress_bar=True,cache_mode='enable',cache_path=str(a.output/'compiler-cache'))
    r.update(state='compiled_needs_validation',hbm_sha256=sha(a.output/'mobileclip2-text.hbm'))
except BaseException as e:r.update(state='failed',error=repr(e));raise
finally:r['finished_unix']=time.time();save()
print(json.dumps(r,indent=2),flush=True)
