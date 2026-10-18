"""Explicit full-family head O2 composition over an immutable qualified profile family.

Metadata only;does not claim whole-model speed/quality or release. Original
38 embeddings,vision27,text36,prompts and generation are retained unchanged.
"""
from pathlib import Path
import argparse,hashlib,json,os,time
from locateanything_official_family_contract_v1 import BASE,CODE,RESULTS,checked,read_json,verified,package,proof,program,digest
from locateanything_official_family_profile_optimization_v2 import load_official_generator as load_profiles
SCHEMA='locateanything_official_full_family_head_optimization_v1';SELF='locateanything_official_family_head_optimization_v1.py'
PROFILE_SHA='bf3c7084ca8680ad9b55bbbd8f6857ce9ece9a813e33971d9d02ce11db01e07c'
HEAD_BUILDER_SHA='eeb7659eae7366b0bf6c517dbde40c069b9f3c446dcf186fd71834034bbd7545'

def check_head_metadata(m,old):
 assert m['schema']=='locateanything_official_head_optimization_board_v1' and m['component_kind']=='full_head' and m['case_count']==8
 assert m['whole_model_verified'] is False and m['release_approved'] is False and m['current_frozen_trial_recipe_changed'] is False
 s=m['source_status'];original=m['original_source_status']
 assert original==old['source_status'] and m['original_status_sha256']==old['source_status_sha256']=='dd2054442733aeb169ab634ad5749bcb5bf3cf26651cf2b76978bc2f4d2aaf55'
 assert s['status']=='compiled_same_bc_full_head_o2_bpu_only' and s['bpu_only'] is True and s['vocabulary']==152681 and s['source_sha256']==HEAD_BUILDER_SHA
 assert s['optimization']==s['compile_jobs']==2 and s['maximum_compile_seconds'] is None and s['recalibration_executed'] is False and s['weights_or_graph_changed'] is False and s['current_frozen_trial_recipe_changed'] is False
 assert s['origin_status_sha256']==m['original_status_sha256'] and s['origin_hbm_sha256']==original['hbm_sha256']=='1f5fdcf001dc95dd4de424b488d1b8c0f9af652513dbe976ffea6f5d4c055385'
 assert s['converted_bc_sha256']==original['converted_bc_sha256']=='e0353110deeaf22f7d89ed462be8c850e7bd53a2bc1b5b48b5372e6abdf1678e'
 assert m['inputs']==old['inputs'] and m['outputs']==old['outputs'] and m['models']==[dict(name='official-q8',hbm_sha256=s['hbm_sha256'])]
 assert set(m['files'])==set(old['files'])|{'disas.json','origin-status.json'}
 for name,entry in old['files'].items():
  if name not in {'official-q8/model.hbm','source-status.json'}:assert m['files'][name]==entry
 assert m['files']['official-q8/model.hbm']==dict(bytes=s['hbm_bytes'],sha256=s['hbm_sha256'])
 assert m['files']['origin-status.json']['sha256']==m['original_status_sha256'] and m['files']['source-status.json']['sha256']==m['source_status_sha256']

def load_official_generator(path,expected_sha256):
 p=checked(path);assert digest(p)==expected_sha256;c=read_json(p)
 assert set(c)=={'schema','architecture','evaluation_only','release_approved','whole_model_verified','profile_family','head','runtime_source_sha256','builder_sha256','composition'}
 assert c['builder_sha256']==digest(CODE/SELF)
 assert c['schema']==SCHEMA and c['architecture']=='original36_qwen_moonvit27_shared_programs' and c['evaluation_only'] is True and c['release_approved'] is False and c['whole_model_verified'] is False
 assert c['runtime_source_sha256']=={SELF:digest(CODE/SELF),'locateanything_official_family_profile_optimization_v2.py':PROFILE_SHA} and digest(CODE/'locateanything_official_family_profile_optimization_v2.py')==PROFILE_SHA
 base=c['profile_family'];assert set(base)=={'path','sha256'};generator,original=load_profiles(base['path'],base['sha256']);oldroot,old=package(original['vocabulary']['head'],'locateanything_official_component_board_v1')
 head=c['head'];assert set(head)=={'root','manifest_sha256','proof'}
 root,m=package(head,'locateanything_official_head_optimization_board_v1');check_head_metadata(m,old)
 guard,hardware=proof(head['proof']);assert guard['manifest_sha256']==head['manifest_sha256'] and hardware['board_calls']==320 and hardware['all_outputs_compiler_bitwise_exact'] is True
 assert guard['worker_sha256']=='64f6dbe06b2b3981a956f3b873e0bd93ed1e11cb9497d922285eadd821067f13' and guard['source_sha256']=='82571b51b9214fe63554187e2aa616cad7cd360959ff0d40439505398dd67d15'
 assert set(hardware['models'])=={'official-q8','original-o0'} and hardware['models']['official-q8']['hbm_sha256']==m['source_status']['hbm_sha256'] and hardware['models']['original-o0']['hbm_sha256']==old['source_status']['hbm_sha256']
 assert hardware['paired_speedup_original_over_o2']>1 and guard['hardware_report_sha256']==digest(root/'board-proof-v3.json') and hardware==read_json(root/'board-proof-v3.json')
 assert all(x==0 for x in guard['owned_ion_after_exit'].values())
 meta=dict(path=str(root/'disas.json'),sha256=m['files']['disas.json']['sha256']);disas=verified(meta);assert len(disas['graphs'])==1
 spec=program('full-vocabulary-head',root/'official-q8/model.hbm',m['source_status']['hbm_sha256'],meta,disas['graphs'][0]['name'],m['inputs'],m['outputs'],['float32'],['float32','float32'])
 from locateanything_official_family_v1 import OfficialVocabulary,OfficialFullBpuGenerator
 vocabulary=OfficialVocabulary([s for s in generator.vocabulary.specs if s.key.startswith('embedding-')],spec)
 result=OfficialFullBpuGenerator(generator.vision,generator.decoder,vocabulary,generator.rope,generator.image_token_index,generator.token_ids)
 assert len(result.specs)==76 and len({str(s.path.resolve()) for s in result.specs})==46
 assert c['composition']==dict(profile_groups=original['optimization_admission']['replaced_first_layers'],optimized_head=True,vocabulary=152681,vision_blocks=27,text_layers=36,logical_programs=76,physical_hbms=46)
 return result,c

def main():
 p=argparse.ArgumentParser();p.add_argument('--profile-family',type=Path,required=True);p.add_argument('--profile-family-sha',required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
 assert a.out.parent.resolve()==BASE and a.out.name.startswith('official-full-family-w8a16-o2-') and a.out.suffix=='.json' and not a.out.exists()
 _,profile=load_profiles(a.profile_family,a.profile_family_sha);head=BASE/'official-full-head-w8-o2-v1-board-package';guard=RESULTS/(head.name+'-guard-v1.json')
 c=dict(schema=SCHEMA,architecture='original36_qwen_moonvit27_shared_programs',evaluation_only=True,release_approved=False,whole_model_verified=False,profile_family=dict(path=str(a.profile_family),sha256=a.profile_family_sha),head=dict(root=str(head),manifest_sha256=digest(head/'manifest.json'),proof=dict(path=str(guard),sha256=digest(guard))),runtime_source_sha256={SELF:digest(CODE/SELF),'locateanything_official_family_profile_optimization_v2.py':PROFILE_SHA},builder_sha256=digest(__file__),composition=dict(profile_groups=profile['optimization_admission']['replaced_first_layers'],optimized_head=True,vocabulary=152681,vision_blocks=27,text_layers=36,logical_programs=76,physical_hbms=46))
 tmp=a.out.with_name(a.out.name+'.incoming-v1');assert not tmp.exists();tmp.write_text(json.dumps(c,indent=2)+'\n');pin=digest(tmp)
 try:
  load_official_generator(tmp,pin);os.chown(tmp,1000,1000);assert not a.out.exists();tmp.replace(a.out)
 except BaseException:
  tmp.rename(a.out.with_name(a.out.name+'.failed-'+str(time.time_ns())));raise
 print(json.dumps(dict(status='complete_head_optimized_contract_admitted_zero_nn_calls',path=str(a.out),sha256=pin,composition=c['composition'],release_approved=False)))
if __name__=='__main__':main()
