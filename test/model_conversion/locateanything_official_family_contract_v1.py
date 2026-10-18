"""Checked complete original-architecture official Q8 evaluation family;no reduced-layer fallback.

Loads source metadata only. HBM hashing occurs once per physical file in the
thread-owned executor. Release still requires complete independent quality,
resident-memory/speed and native service/SEI/archive/UI evidence.
"""
from pathlib import Path,PurePosixPath
import json,hashlib
ROOT=Path('/home/sunrise/ainvr');BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1');RESULTS=ROOT/'test/results';CODE=Path(__file__).resolve().parent
ORIGINAL_BASIS_SHA='3bf0014b3e1b1d1b00014875ee37f7120848a2a3bbdaf231ade356319a08f942'
TOKEN_SHA='792af529b7513822f57e8b5c379c9591b8f08d458b7af6929b6a4d86e8c3d390'
POLICY_SHA='e6574f8e5a5c038da724325ca9c826a3a1581ca84c0df1de7724ff836750145a'
SOURCES=frozenset(['locateanything_official_family_contract_v1.py','locateanything_official_family_v1.py','locateanything_official_program_executor_v1.py','locateanything_official_group_routing_v1.py','locateanything_bpu_vision_v1.py','locateanything_bpu_vocabulary_v1.py','locateanything_bpu_generation_v1.py','locateanything_bpu_decoder_v1.py','locateanything_bpu_components_v1.py','locateanything_bpu_components_v2.py','locateanything_generation_control_v1.py','locateanything_sampling_v1.py'])

def digest(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
def checked(p,roots=(BASE,)):
 p=Path(p);assert p.is_absolute() and not p.is_symlink();resolved=p.resolve();assert any(resolved.is_relative_to(root) for root in roots);return resolved
def read_json(p):
 p=checked(p,(BASE,RESULTS));assert p.is_file() and 0<p.stat().st_size<16*1024**2;return json.loads(p.read_text())
def verified(ref,roots=(BASE,)):
 assert set(ref)=={'path','sha256'};p=checked(ref['path'],roots);assert digest(p)==ref['sha256'];return read_json(p)
def verify_sources(pins):
 assert set(pins)==SOURCES and CODE.is_relative_to(ROOT)
 for name,h in pins.items():assert digest(CODE/name)==h,('Runtime source changed',name)
def package(ref,schema):
 root=checked(ref['root']);assert digest(root/'manifest.json')==ref['manifest_sha256'];m=read_json(root/'manifest.json');assert m['schema']==schema and m['whole_model_verified'] is False and m['release_approved'] is False
 for name,entry in m['files'].items():
  n=PurePosixPath(name);assert not n.is_absolute() and '..' not in n.parts and '.' not in n.parts
  if name.startswith('case-'):continue
  p=checked(root/name);assert p.is_relative_to(root) and p.stat().st_size==entry['bytes']
  if p.suffix!='.hbm':assert digest(p)==entry['sha256']
 assert m['source_status']==read_json(root/'source-status.json');return root,m
def program(key,path,hbm_sha,metadata_ref,name,inputs,outputs,input_dtypes,output_dtypes):
 from locateanything_official_program_executor_v1 import ProgramSpec
 meta=verified(metadata_ref);assert meta['graphs'] and all(g['nodes'] and all(n['device']=='DEVICE_CATEGORY_BPU' for n in g['nodes']) for g in meta['graphs']);assert name in {g['name'] for g in meta['graphs']}
 return ProgramSpec(key,checked(path),hbm_sha,checked(metadata_ref['path']),metadata_ref['sha256'],name,tuple(x['name'] for x in inputs),tuple(tuple(x['shape']) for x in inputs),tuple(input_dtypes),tuple(x['name'] for x in outputs),tuple(tuple(x['shape']) for x in outputs),tuple(output_dtypes))
def proof(ref):
 p=verified(ref,(BASE,RESULTS));assert p['status']=='completed' and p['production_unchanged_and_fresh'] and p['hardware']['status']=='completed' and p['hardware']['all_models_released'];return p,p['hardware']

def load_vision(entry,basis):
 from locateanything_official_family_v1 import LegacyVisionProxy,OfficialVisionBlock
 from locateanything_bpu_vision_v1 import BpuVisionStage,FullVision
 root,m=package(entry['blocks'],'locateanything_official_vision_native_board_v1');assert m['stage_count']==27 and len(m['programs'])==27 and [x['stage'] for x in m['source_status']['components']]==list(range(27));metadata=dict(path=str(root/'disas.json'),sha256=m['files']['disas.json']['sha256']);blocks=[]
 for i,p in enumerate(m['programs']):
  s=program(f'vision-block-{i:02d}',root/'official-q8/model.hbm',m['files']['official-q8/model.hbm']['sha256'],metadata,p['name'],p['inputs'],p['outputs'],['float32'],['float32']);blocks.append(OfficialVisionBlock(i,s))
 stages={}
 for kind in ['prefix','connector']:
  e=entry[kind];d=checked(e['root']);assert digest(d/'status.json')==e['status_sha256'] and digest(d/'ports.json')==e['ports_sha256'];expected=basis['vision'][kind]['hbm_sha256'];stage=BpuVisionStage(kind,d,expected);ports=read_json(d/'ports.json');meta=verified(e['metadata']);assert len(meta['graphs'])==1;inputs=[dict(name=x['name'],shape=list(shape)) for x,shape in zip(ports['inputs'],stage.spec.input_shapes)];outputs=[dict(name=ports['outputs'][0]['name'],shape=list(stage.output_shape))];s=program(stage.spec.key,d/'model.hbm',expected,e['metadata'],meta['graphs'][0]['name'],inputs,outputs,stage.spec.input_dtypes,['float32']);stages[kind]=LegacyVisionProxy(stage,s)
 guard,h=proof(entry['proof']);fm=verified(entry['fixture_manifest']);assert guard['manifest_sha256']==entry['fixture_manifest']['sha256'] and fm['reference_manifest_sha256']==entry['blocks']['manifest_sha256'] and fm['original_contract_sha256']==ORIGINAL_BASIS_SHA;assert h['board_calls']==1044 and len(h['native_comparisons'])==36 and h['all_repeated_outputs_bitwise_exact']
 return FullVision(stages['prefix'],blocks,stages['connector'])

def load_vocabulary(entry,basis):
 from locateanything_official_family_v1 import OfficialVocabulary
 eroot=checked(entry['embedding_root']);em=verified(entry['embedding_manifest']);assert entry['embedding_manifest']['sha256']==basis['vocabulary']['embedding_manifest_sha256'] and checked(entry['embedding_manifest']['path'])==eroot/'manifest.json';mm=verified(entry['metadata_index']);assert mm['status']=='disassembled_all_original_embeddings' and mm['original_vocabulary']==152681 and mm['embedding_manifest_sha256']==entry['embedding_manifest']['sha256'] and len(mm['models'])==len(em['chunks'])==38;meta_root=checked(entry['metadata_index']['path']).parent;specs=[];start=0
 for i,(chunk,meta) in enumerate(zip(em['chunks'],mm['models'])):
  assert chunk['chunk']==meta['chunk']==i and chunk['start']==meta['start']==start and chunk['count']==meta['count']==min(4096,152681-start) and chunk['directory']==f'chunk-{i:02d}' and chunk['hbm_sha256']==meta['hbm_sha256'];d=checked(eroot/chunk['directory']);state=read_json(d/'status.json');assert state['status']=='compiled_bpu_only' and state['bpu_only'] and state['hbm_sha256']==chunk['hbm_sha256'];ports=read_json(d/'ports.json');metadata=dict(path=str(meta_root/meta['disas_file']),sha256=meta['disas_sha256']);inputs=[dict(name=ports['inputs'][0]['name'],shape=[1])];outputs=[dict(name=ports['outputs'][0]['name'],shape=[1,2048])];specs.append(program(f'embedding-{i:02d}',d/'model.hbm',chunk['hbm_sha256'],metadata,meta['program'],inputs,outputs,['int32'],['float32']));start+=chunk['count']
 assert start==152681;root,hm=package(entry['head'],'locateanything_official_component_board_v1');source=hm['source_status'];assert source['status']=='compiled_bpu_only' and source['bpu_only'] and source['vocabulary']==152681 and source['weights_bits']==8 and source['bf16_output_format_preserved'] and source['original_norm_epsilon_preserved'];meta=verified(entry['head_metadata']);assert len(meta['graphs'])==1;hs=program('full-vocabulary-head',root/'official-q8/model.hbm',hm['files']['official-q8/model.hbm']['sha256'],entry['head_metadata'],meta['graphs'][0]['name'],hm['inputs'],hm['outputs'],['float32'],['float32','float32'])
 guard,h=proof(entry['proof']);fm=verified(entry['fixture_manifest']);assert guard['manifest_sha256']==entry['fixture_manifest']['sha256'] and fm['embedding_manifest_sha256']==entry['embedding_manifest']['sha256'] and fm['metadata_manifest_sha256']==entry['metadata_index']['sha256'] and fm['head_manifest_sha256']==entry['head']['manifest_sha256'];assert h['board_calls']==122 and h['retained_contexts_before_close']==39 and h['original_vocabulary']==152681 and h['all_outputs_compiler_bitwise_exact'] and h['executor_stats']['loads']==h['executor_stats']['evictions']==39
 return OfficialVocabulary(specs,hs)

def load_group(entry):
 from locateanything_official_family_v1 import OfficialDecoderGroup
 start,end=entry['first'],entry['last'];assert (start,end) in [(0,8),(9,17),(18,26),(27,35)];root,m=package(entry,'locateanything_official_qwen_group_board_v1');s=m['source_status'];assert s['status']=='compiled_original_group_shared_profiles_bpu_only' and s['bpu_only'] and s['first']==start and s['last']==end and s['layer_count']==9 and s['weight_bits']==8 and s['attention_activation_bits']==16 and s['original_norm_epsilon_preserved'] and s['official_quantized_linear_build_unmodified'];assert s['source_sha256'] in ['295cd6ac6413a0eacb4aa13be7c2bb57984c46a856999092fd121c8abeae8499','5e8bd1b7992143c8abdb005a1729f224bbddc4e9ad69b576e5dac6338e347091'];assert len(s['calibration'])==192 and set(s['original_parameter_hashes'])=={str(i) for i in range(start,end+1)} and all(s['original_parameter_hashes'][str(i)] for i in range(start,end+1));assert len({x['range_hash'] for x in s['profiles']})==1
 metadata=dict(path=str(root/'disas.json'),sha256=m['files']['disas.json']['sha256']);profiles={};assert len(m['profiles'])==2
 for p in m['profiles']:
  q=p['sequence'];assert q in [1,256];kind='ar' if q==1 else 'prefill';assert kind not in profiles;profiles[kind]=program(f'decoder-group-{start:02d}-{end:02d}-{kind}',root/'official-q8/model.hbm',m['files']['official-q8/model.hbm']['sha256'],metadata,p['name'],p['inputs'],p['outputs'],['float32']*22,['float32']*19)
 guard,h=proof(entry['proof']);assert guard['manifest_sha256']==entry['manifest_sha256'] and h['board_calls']==80 and h['all_outputs_compiler_bitwise_exact'] and h['executor_stats']['loads']==h['executor_stats']['evictions']==1 and h['executor_stats']['logical_programs']==2 and h['executor_stats']['physical_hbm_files']==1
 return OfficialDecoderGroup(start,end,profiles),s['original_model_code_sha256']

def load_official_generator(path,expected_sha256):
 path=checked(path);assert digest(path)==expected_sha256;c=read_json(path)
 assert c['schema']=='locateanything_official_full_family_v1' and c['architecture']=='original36_qwen_moonvit27_shared_programs' and c['evaluation_only'] is True and c['release_approved'] is False and c['enabled_generation_modes']==['slow'];verify_sources(c['runtime_source_sha256'])
 assert c['original_basis']['sha256']==ORIGINAL_BASIS_SHA and c['token_contract']['sha256']==TOKEN_SHA and c['acceptance_policy']['sha256']==POLICY_SHA;basis=verified(c['original_basis']);tokens=verified(c['token_contract']);policy=verified(c['acceptance_policy'],(BASE,RESULTS));assert policy['status']=='current_user_requirement' and c['quality_policy']==policy['box_agreement'] and policy['box_agreement']['iou_threshold']==.9
 assert (tokens['vision_blocks'],tokens['decoder_layers'],tokens['vocabulary_size'])==(27,36,152681) and tokens['original_config_sha256']=='59e6b5104f9d948db6a38f778e29f86d5c01e373f46d02008fc3070377917007'
 from locateanything_official_family_v1 import OfficialFullDecoder,OfficialFullBpuGenerator
 from locateanything_official_group_routing_v1 import OfficialRopeArrays
 assert len(c['groups'])==4 and [(x['first'],x['last']) for x in c['groups']]==[(0,8),(9,17),(18,26),(27,35)]
 groups=[];original_codes=[]
 for entry in c['groups']:
  group,code=load_group(entry);groups.append(group);original_codes.append(code)
 assert len(set(original_codes))==1,'Original reference model code differs across groups'
 vision=load_vision(c['vision'],basis);vocabulary=load_vocabulary(c['vocabulary'],basis);generator=OfficialFullBpuGenerator(vision,OfficialFullDecoder(groups),vocabulary,OfficialRopeArrays(),tokens['image_token_index'],tokens['token_ids']);assert len(generator.specs)==76 and len({str(x.path.resolve()) for x in generator.specs})==46
 return generator,c
