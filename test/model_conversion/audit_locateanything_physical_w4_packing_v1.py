"""Controlled same-shape W4/W8 physical packing audit;not model quality or whole model."""
import os,sys,json,time,hashlib,traceback,subprocess,gc,signal
from pathlib import Path
for k in ['DEV_B30_TRITON_VPU','DEV_B30_ENABLE_VPU_EXTRA_OP','DEV_B30_ENABLE_VPU_TRIAL_OP']:os.environ[k]='1'
sys.path.insert(0,'/opt/locate-oellm-research-v1/sdk448-isolated/python')
import numpy as np,torch
from safetensors import safe_open
from hbdk4.compiler import leap,save,convert,compile
ROOT=Path('/opt/locate-w4-w8-physical-packing-v1');assert not ROOT.exists();ROOT.mkdir()
r=dict(status='preparing',started=time.time(),scope=__doc__,source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),cases=[],board_calls=0,whole_model_verified=False,release_approved=False)
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def save_report():
 p=ROOT/'status.json.tmp';p.write_text(json.dumps(r,indent=2)+'\n');p.replace(ROOT/'status.json')
def mem():return int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024
signal.signal(signal.SIGALRM,lambda *_:(_ for _ in ()).throw(TimeoutError('900second owned packing audit bound')));signal.alarm(900)
try:
 torch.set_num_threads(2);assert mem()>10*1024**3;save_report()
 model=Path('/model');idx=json.loads((model/'model.safetensors.index.json').read_text())['weight_map'];name='language_model.model.layers.0.self_attn.q_proj.weight'
 with safe_open(str(model/idx[name]),framework='pt',device='cpu') as f:w=f.get_tensor(name).float().numpy()
 assert w.shape==(2048,2048)
 x=np.load('/work/gptq-projection-probe-v2/seq1/input.npy');assert x.shape==(1,2048) and x.dtype==np.float32
 for bits in [4,8]:
  assert mem()>6*1024**3;directory=ROOT/f'w{bits}';directory.mkdir();qmax=2**(bits-1)-1;scales=np.maximum(np.abs(w).max(1)/qmax,1e-12).astype(np.float32);codes=np.clip(np.rint(w/scales[:,None]),-qmax,qmax).astype(np.int8)
  item=dict(logical_weight_bits=bits,unpacked_export_dtype=str(codes.dtype),same_shape=[2048,2048],logical_packed_payload_bytes=2048*2048*bits//8,weight_code_min=int(codes.min()),weight_code_max=int(codes.max()),physical_packing_verified=False);r['cases'].append(item);save_report()
  def build(value):
   value=leap.const_fake_quant(value,[-32.],[32.],16,True)
   weight=leap.dequantize(torch.from_numpy(codes),scales=scales.tolist(),zeros=[0]*2048,axis=0)
   return leap.linear(value,weight)
  exported=leap.leap_export(build,leap.TensorType([1,2048],leap.float32),name=f'packing_audit_w{bits}').module
  save(exported,str(directory/'export.bc'));lowered=convert(exported,'nash-m');save(lowered,str(directory/'converted.bc'));text=str(lowered.module);(directory/'converted.mlir').write_text(text)
  item['converted_ir_int4_type_occurrences']=text.count('si4');item['converted_ir_explicit_int4_attribute']=('isInt4 = true' in text or 'is_int4 = true' in text)
  f=lowered.functions[0];compiled_reference=np.asarray(f(x)[0]).copy();np.save(directory/'input.npy',x);np.save(directory/'compiler-output.npy',compiled_reference)
  step=32/32768.;qx=np.clip(np.rint(x/step),-32768,32767)*step;gold=qx@(codes.astype(np.float32)*scales[:,None]).T
  item['compiler_vs_same_quantized_source_maxabs']=float(np.abs(compiled_reference-gold).max());assert np.allclose(compiled_reference,gold,rtol=2e-5,atol=2e-4)
  ports=dict(inputs=[dict(name=p.name) for p in f.inputs],outputs=[dict(name=p.name) for p in f.outputs]);(directory/'ports.json').write_text(json.dumps(ports,indent=2))
  r['status']=f'compiling_w{bits}';save_report();compile(lowered,str(directory/'model.hbm'),march='nash-m',opt=0,jobs=1)
  disas=json.loads(subprocess.check_output(['/opt/locate-oellm-research-v1/sdk448-isolated/python/hbdk4/compiler/_mlir_libs/hbrt4-disas','--json',str(directory/'model.hbm')],text=True));(directory/'disas.json').write_text(json.dumps(disas,indent=2));devices=[n['device'] for g in disas['graphs'] for n in g['nodes']];assert devices and all(d=='DEVICE_CATEGORY_BPU' for d in devices)
  item.update(status='compiled_bpu_only',hbm_bytes=(directory/'model.hbm').stat().st_size,hbm_sha256=sha(directory/'model.hbm'),bpu_only=True,disas_sha256=sha(directory/'disas.json'));save_report();del exported,lowered;gc.collect()
 r.update(status='completed',physical_hbm_w4_over_w8_ratio=r['cases'][0]['hbm_bytes']/r['cases'][1]['hbm_bytes'],note='File size ratio and disassembly are controlled packing evidence;do not infer whole-model RAM/quality or native MMA bitwidth from code range alone.',finished=time.time());save_report()
except BaseException:r.update(status='failed',error=traceback.format_exc(),finished=time.time());save_report();raise
finally:signal.alarm(0)
