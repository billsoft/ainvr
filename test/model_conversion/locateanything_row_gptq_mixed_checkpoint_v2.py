"""Research-only mixed checkpoint admission and exact original-weight bridge to unmodified official W8/W4 Linear."""
from pathlib import Path
import hashlib,json,math,re
import numpy as np
from locateanything_row_gptq_checkpoint_v1 import SUFFIXES,digest,read_weight,apply_official_linear
PREPARATION_SHA='a350ee6bc5225c934d47be8729c270e4113b5a71c0bac351f4735aad16596b83'
def read_attention_weight(root,entry,expected_shape,original_bf16_bytes):
 name=entry['name'];match=re.fullmatch(r'language_model\.model\.layers\.(\d+)\.(.+)',name)
 if not match or not 0<=int(match[1])<36 or match[2] not in SUFFIXES[:4]:raise ValueError('Original attention projection required')
 if entry['logical_weight_bits']!=8 or entry['compiler_uses_original_weight_for_w8'] is not True or entry['deployment_input_permutation_required'] is not False or entry['packed_roundtrip_exact'] is not True:raise ValueError('Official original-weight W8 attention representation required')
 shape=tuple(entry['shape'])
 if shape!=tuple(expected_shape) or len(shape)!=2 or any(type(v) is not int or v<=0 for v in shape):raise ValueError('Original attention shape differs')
 if hashlib.sha256(original_bf16_bytes).hexdigest()!=entry['original_bf16_parameter_sha256']:raise ValueError('Original attention identity differs')
 filename=name+'.npz';path=Path(root).resolve(strict=True)/filename
 if Path(entry['packed_file']).name!=filename or path.is_symlink() or not path.is_file() or digest(path)!=entry['sha256']:raise ValueError('Frozen attention payload differs')
 with np.load(path,allow_pickle=False) as f:
  if set(f.files)!={'codes','scales','shape','weight_bits','group_size','signed_code_offset','code_min','code_max'}:raise ValueError('Unknown W8 research representation')
  if f['shape'].tolist()!=list(shape) or any(f[k].shape!=() or int(f[k])!=v for k,v in [('weight_bits',8),('group_size',-1),('signed_code_offset',0),('code_min',-127),('code_max',127)]):raise ValueError('W8 research metadata differs')
  codes=f['codes'].copy();scales=f['scales'].copy()
 if codes.dtype!=np.int8 or codes.shape!=shape or codes.nbytes!=entry['packed_payload_bytes'] or codes.min()<-127 or scales.dtype!=np.float32 or scales.shape!=(shape[0],1) or scales.nbytes!=entry['scale_bytes'] or not np.isfinite(scales).all() or not (scales>0).all():raise ValueError('W8 research codes/scales differ')
 return codes,scales

def prepare_official_projection(module,root,entry):
 import torch
 from leap_llm.nn.modules.linear import FakeQuantLinear
 role=entry['name'].split('.',4)[-1]
 if role in SUFFIXES[4:]:
  if entry['logical_weight_bits']!=4:raise ValueError('MLP must retain prepared W4 precision')
  return apply_official_linear(module,root,entry)
 if role not in SUFFIXES[:4] or not isinstance(module,FakeQuantLinear) or hasattr(module,'scales') or module.w_bits!=8:raise ValueError('Unmodified official W8 attention required')
 original=module.weight.detach().cpu()
 if original.dtype!=torch.float32 or not torch.equal(original,original.to(torch.bfloat16).float()):raise ValueError('Exact original BF16 attention weights required')
 raw=original.to(torch.bfloat16).contiguous().view(torch.uint8).numpy().tobytes();codes,scales=read_attention_weight(root,entry,original.shape,raw)
 expected_scale=(original.abs().amax(dim=1,keepdim=True)/127).clamp_min(1e-12)
 expected_codes=torch.round(original/expected_scale).clamp(-127,127).to(torch.int8)
 # GPU division and CPU division need not choose the same last scale bit or
 # round-to-nearest result at half-integer ties. Check the mathematical grid
 # with an explicit FP32 rounding bound;do not claim bitwise SDK equivalence.
 scale_np=expected_scale.numpy();observed=scales.astype(np.float64)
 if not np.all(np.abs(observed-scale_np.astype(np.float64))<=2*np.spacing(scale_np).astype(np.float64)):raise ValueError('W8 research scale exceeds FP32 rounding bound')
 ratio=original.numpy().astype(np.float64)/observed
 rounding_bound=.5+2*np.finfo(np.float32).eps*np.maximum(np.abs(ratio),1.)
 if not np.all(np.abs(codes.astype(np.float64)-np.clip(ratio,-127,127))<=rounding_bound):raise ValueError('W8 research code is not nearest on its original symmetric grid')
 # Preserve the original FP32-loaded BF16 parameters. The official exporter
 # quantizes them exactly once;never feed the W8 simulation back as original.
 return codes,scales

def admit_completed_mixed_research_checkpoint(root,manifest_sha256,report_path,report_sha256):
 root=Path(root);manifest=root/'manifest.json';report_path=Path(report_path)
 if digest(manifest)!=manifest_sha256 or digest(report_path)!=report_sha256:raise ValueError('Frozen mixed preparation identities differ')
 m=json.loads(manifest.read_text());r=json.loads(report_path.read_text())
 if r['status']!='completed' or r['manifest_sha256']!=manifest_sha256 or m['source_sha256']!=PREPARATION_SHA or r['source_sha256']!=PREPARATION_SHA:raise ValueError('Exact completed mixed preparation required')
 if (r['text_layers'],r['vision_blocks'],r['vocabulary_size'],r['original_parameter_count'])!=(36,27,152681,3517975280):raise ValueError('Original full-model identity differs')
 modules=m['modules'];expected={f'language_model.model.layers.{i}.{s}' for i in range(36) for s in SUFFIXES}
 if modules!=r['modules'] or len(modules)!=252 or {x['name'] for x in modules}!=expected or [x['index'] for x in r['layers']]!=list(range(36)) or not all(x['status']=='completed' for x in r['layers']):raise ValueError('Complete mixed36 preparation required')
 for x in modules:
  role=x['name'].split('.',4)[-1];bits=8 if role in SUFFIXES[:4] else 4
  if x['logical_weight_bits']!=bits or x['packed_roundtrip_exact'] is not True or x['deployment_input_permutation_required'] is not False:raise ValueError('Mixed precision role or representation differs')
 total=sum(math.prod(x['shape']) for x in modules);four=sum(math.prod(x['shape']) for x in modules if x['logical_weight_bits']==4)
 if total!=2774532096 or not math.isclose(four/total,r['w4_decoder_parameter_fraction'],abs_tol=1e-15) or four/total<.8:raise ValueError('Mixed parameter fraction differs')
 if r['gpu_full_generation_requests']!=64 or r['gpu_calibration_layer_forward_calls']!=10152 or r['gpu_diagnostic_layer_forward_calls']!=1152 or len(r['diagnostic_selection'])!=8:raise ValueError('Sequential calibration/diagnostic coverage differs')
 if r['old_development_floor_passed'] is not True or len(r['cases'])!=64 or not all(c['terminated'] and not c['malformed'] for c in r['cases']):raise ValueError('Historical development control not passed')
 matched=sum(c['matched'] for c in r['cases']);pred=sum(c['candidate'] for c in r['cases']);gold=sum(c['reference'] for c in r['cases'])
 for key,numerator,denominator in [('precision',matched,pred),('recall',matched,gold)]:
  v=r['aggregate'][key];expected_value=numerator/denominator if denominator else float(not (gold if key=='precision' else pred))
  if isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or not .45<=v<=1 or v!=expected_value:raise ValueError('Historical numeric floor/counts not passed')
 # Export permission only:actual physical packing,BPU quality,RAM,TPS and
 # original untouched final acceptance remain separate mandatory evidence.
 return {x['name']:x for x in modules},r
