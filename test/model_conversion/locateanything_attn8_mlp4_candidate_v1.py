"""Admit the actually measured old64 W8-attention/W4-MLP control for research export only;never relabel failed pureW4 or sequential candidates."""
from pathlib import Path
import hashlib,json,math
from locateanything_row_gptq_checkpoint_v1 import SUFFIXES,read_weight,digest
ROOT=Path('/opt/locate-attn8-mlp-rowgptq4-candidate-v1');WEIGHTS=Path('/opt/locate-row-gptq-full36-checkpoint-v2');PURE=Path('/opt/locate-row-gptq-full36-v2/status.json');QUALITY=Path('/opt/locate-row-gptq-attention-ablation-v1/status.json')
PURE_SHA='4d6a3d57b1dafdf7ba4a46eb553af7830c8a3f31f80460560cc9789c2047f40a';QUALITY_SHA='e2076ddcff5ecee57920b13255b637ead7e1185f053f20158bfc7b3640182cb1';PURE_MANIFEST_SHA='d3f352b12995351c0a663e5c92b8e2b5b13c71b62a2afee0820375793ba9b72c'
def verify_sources():
 if digest(PURE)!=PURE_SHA or digest(QUALITY)!=QUALITY_SHA or digest(WEIGHTS/'manifest.json')!=PURE_MANIFEST_SHA:raise ValueError('Exact retained full-model references required')
 pure=json.loads(PURE.read_text());quality=json.loads(QUALITY.read_text());manifest=json.loads((WEIGHTS/'manifest.json').read_text())
 if pure['status']!='completed' or pure['old_development_floor_passed'] is not False or quality['status']!='completed_research_ablation_not_bpu_acceptance' or quality['source_sha256']!='d57aa535eef00817906dc977c061c070639cb669dc10d6650f7ea58191800a9d' or quality['pure_w4_report_sha256']!=PURE_SHA:raise ValueError('Original failed pureW4 and completed control must remain distinct')
 if quality['mlp_weights_reused_without_recalibration'] is not True or quality['checkpoint_splicing_is_explicit_causal_control'] is not True or quality['mlp_projections_loaded']!=108 or quality['attention_projections']!=144 or quality['gpu_full_generation_requests']!=128 or quality['bpu_calls']!=0 or quality['fresh_final_used'] is not False:raise ValueError('Measured mixed precision control provenance differs')
 if quality['vision_connector_embedding_head_norm_bias']!='unchanged original BF16' or pure['original_parameter_count']!=3517975280 or (pure['text_layers'],pure['vision_blocks'],pure['vocabulary_size'])!=(36,27,152681):raise ValueError('Original architecture changed')
 v=next(x for x in quality['variants'] if x['mode']=='attention_w8_mlp_roww4')
 if v['status']!='completed' or len(v['cases'])!=64 or not all(c['terminated'] and not c['malformed'] for c in v['cases']) or not v['historical_numeric_floor_passed'] or not v['historical_operational_passed']:raise ValueError('Full64 mixed control required')
 count=[sum(c[k] for c in v['cases']) for k in ['matched','candidate','reference']]
 if count!=[41,78,78] or v['aggregate']['precision']!=41/78 or v['aggregate']['recall']!=41/78:raise ValueError('Frozen observed mixed quality changed')
 expected={f'language_model.model.layers.{i}.{s}' for i in range(36) for s in SUFFIXES}
 if manifest['modules']!=pure['modules'] or len(pure['modules'])!=252 or {x['name'] for x in pure['modules']}!=expected:raise ValueError('Full projection coverage differs')
 return pure,quality,v

def prepare():
 pure,quality,v=verify_sources()
 if ROOT.exists():raise ValueError('Retain immutable existing candidate;do not overwrite')
 ROOT.mkdir();modules=[]
 for e in pure['modules']:
  role=e['name'].split('.',4)[-1]
  if role in SUFFIXES[4:]:
   codes,scales=read_weight(WEIGHTS,e);del codes,scales
   modules.append(dict(name=e['name'],bits=4,prepared_entry=e,prepared_root=str(WEIGHTS)))
  else:modules.append(dict(name=e['name'],bits=8,shape=e['shape'],original_bf16_parameter_sha256=e['original_bf16_parameter_sha256'],compiler_uses_original_weights=True))
 m=dict(schema='locateanything_attn8_mlp4_research_candidate_v1',source_sha256=digest(__file__),architecture=dict(text_layers=36,vision_blocks=27,vocabulary=152681,parameters=3517975280),scope='Official-style original-weight W8 attention+retained row-GPTQ W4 MLP;other original weights unchanged;historical development research export only',preparation=dict(pure_failed_report_sha256=PURE_SHA,pure_weight_manifest_sha256=PURE_MANIFEST_SHA,mlp_weights_reused_without_recalibration=True,quality_control_sha256=QUALITY_SHA,quality_mode=v['mode'],aggregate=v['aggregate'],fresh_final_used=False),modules=modules,whole_model_bpu_verified=False,release_approved=False)
 (ROOT/'manifest.json').write_text(json.dumps(m,indent=2)+'\n');return m

def admit(manifest_sha256):
 pure,quality,v=verify_sources();path=ROOT/'manifest.json'
 if digest(path)!=manifest_sha256:raise ValueError('Immutable mixed candidate manifest changed')
 m=json.loads(path.read_text());modules=m['modules'];source_entries={x['name']:x for x in pure['modules']}
 if m['source_sha256']!=digest(__file__) or len(modules)!=252 or {x['name'] for x in modules}!=set(source_entries) or m['preparation']['quality_control_sha256']!=QUALITY_SHA or m['preparation']['quality_mode']!=v['mode'] or m['preparation']['aggregate']!=v['aggregate'] or m['architecture']!=dict(text_layers=36,vision_blocks=27,vocabulary=152681,parameters=3517975280):raise ValueError('Candidate composition/coverage differs')
 for e in modules:
  original=source_entries[e['name']];role=e['name'].split('.',4)[-1]
  if role in SUFFIXES[4:]:
   if e['bits']!=4 or e['prepared_entry']!=original or Path(e['prepared_root'])!=WEIGHTS:raise ValueError('Exact measured MLP preparation required')
  elif e['bits']!=8 or e['shape']!=original['shape'] or e['original_bf16_parameter_sha256']!=original['original_bf16_parameter_sha256'] or e['compiler_uses_original_weights'] is not True:raise ValueError('Original W8 attention required')
 return {e['name']:e for e in modules},m

if __name__=='__main__':
 m=prepare();h=digest(ROOT/'manifest.json');entries,_=admit(h);print(json.dumps(dict(status='prepared_research_export_candidate',manifest_sha256=h,mlp_w4=sum(e['bits']==4 for e in entries.values()),attention_w8=sum(e['bits']==8 for e in entries.values()),historical_aggregate=m['preparation']['aggregate'],hbm_compiles=0)))
