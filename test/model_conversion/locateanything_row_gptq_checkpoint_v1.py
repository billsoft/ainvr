"""Read/apply a pinned research row-GPTQ checkpoint to official FQLinear;never runtime inference or release admission."""
from pathlib import Path
import hashlib,json,math,re
import numpy as np
SUFFIXES=('self_attn.q_proj','self_attn.k_proj','self_attn.v_proj','self_attn.o_proj','mlp.gate_proj','mlp.up_proj','mlp.down_proj')
def digest(path):
 h=hashlib.sha256()
 with Path(path).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
def read_weight(root,entry,expected_shape=None,original_bf16_bytes=None):
 root=Path(root).resolve(strict=True);name=entry['name']
 match=re.fullmatch(r'language_model\.model\.layers\.(\d+)\.(.+)',name)
 if not match or not 0<=int(match[1])<36 or match[2] not in SUFFIXES:raise ValueError('Unexpected original text projection')
 if entry['logical_weight_bits']!=4 or entry['packed_roundtrip_exact'] is not True or entry['deployment_input_permutation_required'] is not False:raise ValueError('Signed per-row W4 representation required')
 shape=tuple(entry['shape'])
 if len(shape)!=2 or any(type(x) is not int or x<=0 for x in shape) or shape[1]%2 or (expected_shape is not None and shape!=tuple(expected_shape)):raise ValueError('Original projection shape differs')
 if original_bf16_bytes is not None and hashlib.sha256(original_bf16_bytes).hexdigest()!=entry['original_bf16_parameter_sha256']:raise ValueError('Original BF16 parameter identity differs')
 filename=name+'.npz';declared=Path(entry['packed_file'])
 if declared.name!=filename:raise ValueError('Prepared projection filename differs')
 path=root/filename
 if path.is_symlink() or not path.is_file() or digest(path)!=entry['sha256']:raise ValueError('Prepared projection bytes changed')
 with np.load(path,allow_pickle=False) as f:
  if set(f.files)!={'packed','scales','shape','weight_bits','group_size','signed_code_offset','code_min','code_max'}:raise ValueError('Unknown checkpoint representation')
  if f['shape'].tolist()!=list(shape) or any(f[k].shape!=() or int(f[k])!=value for k,value in [('weight_bits',4),('group_size',-1),('signed_code_offset',8),('code_min',-7),('code_max',7)]):raise ValueError('Quantization metadata differs')
  packed=f['packed'].copy();scales=f['scales'].copy()
 if packed.dtype!=np.uint8 or packed.shape!=(shape[0],shape[1]//2) or packed.nbytes!=entry['packed_payload_bytes'] or scales.dtype!=np.float32 or scales.shape!=(shape[0],1) or scales.nbytes!=entry['scale_bytes'] or not np.isfinite(scales).all() or not (scales>0).all():raise ValueError('Prepared shape/scale payload differs')
 codes=np.empty(shape,dtype=np.int8);codes[:,0::2]=((packed&15).astype(np.int16)-8).astype(np.int8);codes[:,1::2]=((packed>>4).astype(np.int16)-8).astype(np.int8)
 if codes.min()<-7 or codes.max()>7:raise ValueError('Reserved/out-of-range signed W4 code')
 return codes,scales

def apply_official_linear(module,root,entry):
 import torch
 from leap_llm.nn.modules.linear import FakeQuantLinear
 if not isinstance(module,FakeQuantLinear) or hasattr(module,'scales'):raise ValueError('An original,unmodified official FQLinear is required')
 if module.weight.dtype!=torch.float32 or not torch.equal(module.weight.detach().cpu(),module.weight.detach().cpu().to(torch.bfloat16).float()):raise ValueError('Original BF16 weights must be loaded exactly as FP32 compiler parameters')
 original=module.weight.detach().to('cpu',torch.bfloat16).contiguous().view(torch.uint8).numpy().tobytes()
 codes,scales=read_weight(root,entry,module.weight.shape,original)
 with torch.no_grad():module.weight.copy_(torch.from_numpy(codes).to(module.weight.device,module.weight.dtype)*torch.from_numpy(scales).to(module.weight.device,module.weight.dtype))
 module.register_buffer('scales',torch.from_numpy(scales).to(module.weight.device));module.has_scale=True;module.w_bits=4
 return codes,scales

def admit_completed_research_checkpoint(root,manifest_sha256,report_path,report_sha256):
 root=Path(root);manifest=root/'manifest.json';report_path=Path(report_path)
 if digest(manifest)!=manifest_sha256 or digest(report_path)!=report_sha256:raise ValueError('Frozen preparation identities differ')
 data=json.loads(manifest.read_text());r=json.loads(report_path.read_text())
 if r['status']!='completed' or r['manifest_sha256']!=manifest_sha256 or data['source_sha256']!=r['source_sha256'] or r['source_sha256']!='27e21707255278e26254b7336a50e663963006329e2a78d404b398678e9ef4f9':raise ValueError('Exact completed preparation required')
 if r['text_layers']!=36 or r['vision_blocks']!=27 or r['vocabulary_size']!=152681 or r['original_parameter_count']!=3517975280 or r['w4_decoder_parameter_fraction']!=1.0:raise ValueError('Full original model identity differs')
 if r['old_development_floor_passed'] is not True or len(r['cases'])!=64 or not all(c['terminated'] and not c['malformed'] for c in r['cases']):raise ValueError('Historical development control not passed')
 for key in ['precision','recall']:
  v=r['aggregate'][key]
  if isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or not .45<=v<=1:raise ValueError('Historical numeric floor not passed')
 expected={f'language_model.model.layers.{i}.{s}' for i in range(36) for s in SUFFIXES};modules=data['modules']
 if modules!=r['modules'] or len(modules)!=252 or {x['name'] for x in modules}!=expected or [x['index'] for x in r['layers']]!=list(range(36)) or not all(x['status']=='completed' for x in r['layers']):raise ValueError('Complete36-layer preparation required')
 # This admission permits research export only. It cannot certify BPU quality,
 # physical weight packing,whole-model runtime memory/speed or UI release.
 return {x['name']:x for x in modules},r
