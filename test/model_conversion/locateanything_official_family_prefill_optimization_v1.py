"""Explicit complete-family composition with board-qualified same-BC prefillO2.

Only first9-layer physical HBM is replaced;its AR HBO is unchanged. No partial
architecture,weight/quantization change or whole-model release is implied.
"""
from pathlib import Path
import argparse,json,os
from locateanything_official_family_contract_v1 import BASE,CODE,RESULTS,checked,read_json,digest,program
SELF='locateanything_official_family_prefill_optimization_v1.py';SCHEMA='locateanything_official_full_family_prefill_optimization_v1'
HELPER='locateanything_prefill_component_admission_v1.py';HELPER_SHA='ba71bdf4e0c05725b511857e34e5dca43979a56b694bd7b7521b77aebb961cc0'
HEAD='locateanything_official_family_head_optimization_v1.py';HEAD_SHA='3ff3405fd38d2622e0cd2ac5b83f9d25b1d18450951dc32929453f5e261ce7a8'
BASE_PATH=BASE/'official-full-family-w8a16-o2-all-ar-head-v1.json';BASE_SHA='fd3e01f51bc36edaa62b3f5f45fc8507f03ae263ed53420fbc3df3cfb1fed042'
MANIFEST_SHA='c2a84c1ebce17d6837cb498239612050a40d585a73b7bc0fb1600921419898cd';GUARD=RESULTS/'locateanything-w8-prefill-o2-v130-board-guard.json';GUARD_SHA='78b7414a0628ca6a9cbb022c416433b6c930ab4c3edfcde3e545ca1bb051afb8'
def load_official_generator(path,expected_sha256):
 p=checked(path);assert digest(p)==expected_sha256;c=read_json(p)
 assert set(c)=={'schema','architecture','evaluation_only','whole_model_verified','release_approved','base_family','prefill_component','runtime_source_sha256','builder_sha256','composition'}
 assert c['schema']==SCHEMA and c['architecture']=='original36_qwen_moonvit27_shared_programs' and c['evaluation_only'] is True and c['whole_model_verified'] is False and c['release_approved'] is False and c['builder_sha256']==digest(CODE/SELF)
 expected={SELF:digest(CODE/SELF),HELPER:HELPER_SHA,HEAD:HEAD_SHA};assert c['runtime_source_sha256']==expected and all(digest(CODE/n)==pin for n,pin in expected.items())
 assert c['base_family']==dict(path=str(BASE_PATH),sha256=BASE_SHA) and c['prefill_component']==dict(manifest_sha256=MANIFEST_SHA,guard_path=str(GUARD),guard_sha256=GUARD_SHA)
 from locateanything_prefill_component_admission_v1 import admit,PACKAGE
 from locateanything_official_family_head_optimization_v1 import load_official_generator as load_base
 m,profiles=admit(MANIFEST_SHA);assert digest(GUARD)==GUARD_SHA;g=read_json(GUARD);raw=BASE/'official-w8-prefill-o2-v130-benchmark/status.json';h=read_json(raw)
 assert g['status']=='completed_component_parity_and_timing_not_fullmodel_admission' and g['source_sha256']=='40f3ed206a7329ea342763b385d7bf9daf366f6e333bfe188b7b16474119e669' and g['manifest_sha256']==MANIFEST_SHA and g['hardware_report_sha256']==digest(raw)=='7bcdb0e31894dbe298e070d5cc061a8aee5801a04cf50718b08cb10b6b03f3a0' and g['proof']==h and g['original_current_user_configuration_and_real_SEI_restored'] and not any(g['owned_ion_after_exit'].values())
 assert h['status']=='completed_same_bc_component_measurement_not_fullmodel_approval' and h['calls']==192 and h['comparisons']==3648 and h['all_outputs_compiler_byte_exact'] and h['all_models_released'] and h['component_speed_screen_passed'] and h['profile_timings']['256']['median_paired_ratio']>=1.03 and h['profile_timings']['1']['median_paired_ratio']>=.98
 assert all(x['median_paired_ratio']>=.99 for x in h['profile_timings']['256']['cases'])
 original,_=load_base(BASE_PATH,BASE_SHA)
 from locateanything_official_family_v1 import OfficialDecoderGroup,OfficialFullDecoder,OfficialFullBpuGenerator
 metadata=dict(path=str(PACKAGE/'disas.json'),sha256=m['files']['disas.json']['sha256']);specs={}
 for entry in profiles:
  seq=entry['sequence'];assert seq in [1,256];kind='ar' if seq==1 else 'prefill';assert kind not in specs
  specs[kind]=program('decoder-group-00-08-'+kind,PACKAGE/'model.hbm',m['candidate_hbm_sha256'],metadata,entry['name'],entry['inputs'],entry['outputs'],['float32']*22,['float32']*19)
 groups=list(original.decoder.groups);assert (groups[0].start,groups[0].end)==(0,8);groups[0]=OfficialDecoderGroup(0,8,specs)
 result=OfficialFullBpuGenerator(original.vision,OfficialFullDecoder(groups),original.vocabulary,original.rope,original.image_token_index,original.token_ids)
 old={s.key:s for s in original.specs};new={s.key:s for s in result.specs};assert set(old)==set(new) and len(new)==76 and len({str(s.path.resolve()) for s in result.specs})==46
 changed={k for k in old if old[k]!=new[k]};assert changed=={'decoder-group-00-08-ar','decoder-group-00-08-prefill'}
 for k in changed:
  for attr in ['key','program','input_names','input_shapes','input_dtypes','output_names','output_shapes','output_dtypes']:assert getattr(old[k],attr)==getattr(new[k],attr)
 assert c['composition']==dict(replaced_physical_first_layers=[0],prefill_O2_first_layers=[0],unchanged_AR_HBO=True,text_layers=36,vision_blocks=27,vocabulary=152681,logical_programs=76,physical_hbms=46)
 return result,c
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path,required=True);a=parser.parse_args();assert a.out.parent.resolve()==BASE and a.out.suffix=='.json' and a.out.name.startswith('official-full-family-w8a16-prefill-') and not a.out.exists()
 c=dict(schema=SCHEMA,architecture='original36_qwen_moonvit27_shared_programs',evaluation_only=True,whole_model_verified=False,release_approved=False,base_family=dict(path=str(BASE_PATH),sha256=BASE_SHA),prefill_component=dict(manifest_sha256=MANIFEST_SHA,guard_path=str(GUARD),guard_sha256=GUARD_SHA),runtime_source_sha256={SELF:digest(CODE/SELF),HELPER:HELPER_SHA,HEAD:HEAD_SHA},builder_sha256=digest(__file__),composition=dict(replaced_physical_first_layers=[0],prefill_O2_first_layers=[0],unchanged_AR_HBO=True,text_layers=36,vision_blocks=27,vocabulary=152681,logical_programs=76,physical_hbms=46))
 p=a.out.with_name(a.out.name+'.incoming-v130');assert not p.exists();p.write_text(json.dumps(c,indent=2)+'\n');pin=digest(p)
 try:generator,_=load_official_generator(p,pin);os.chown(p,1000,1000);assert not a.out.exists();p.replace(a.out)
 except BaseException:p.rename(a.out.with_name(a.out.name+'.failed-metadata-v130'));raise
 print(json.dumps(dict(status='complete_prefill_O2_family_metadata_admitted_zero_nn_calls',path=str(a.out),sha256=pin,logical_programs=len(generator.specs),physical_hbms=len({str(s.path.resolve()) for s in generator.specs}),whole_model_verified=False,release_approved=False)))
if __name__=='__main__':main()
