"""Validate immutable native final reference before candidate evaluation; no NN calls.

Raw baseline remains unchanged. Invalid native output cannot become gold; all160
candidate operations remain required,including the separately reported baseline
failure. No sample replacement,threshold change or candidate result inspection.
"""
from pathlib import Path
import ast,hashlib,json,sys,re,time,argparse,os
import numpy as np
ROOT=Path('/home/sunrise/ainvr');BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1');REF=BASE/'independent-final-native-reference-v2-head-o2'
RAW_SHA=None
PLAN_SHA='3794d81db93177a3b810934bc635d91c1057341609287021e46d9ca4d89b8789'
FREEZE_SHA='36a738d86f0a2f082d877544f14399f725b52fe585d1f87f79b7769cd1e1d2fb'
TOKEN_SHA='f56587c1c7b4d69be60b018606b1bf2f90e46ca9d51fb2689090997281df7e40'
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def write_new(p,d):
 assert not p.exists();tmp=p.with_name(p.name+'.incoming-v1');assert not tmp.exists();tmp.write_text(json.dumps(d,indent=2,allow_nan=False)+'\n');assert not p.exists();tmp.replace(p)
def main():
 global RAW_SHA
 p=argparse.ArgumentParser();p.add_argument('--raw-sha',required=True);args=p.parse_args();RAW_SHA=args.raw_sha;assert re.fullmatch('[0-9a-f]{64}',RAW_SHA)
 assert sha(REF/'status.json')==RAW_SHA and sha(REF/'case-plan.json')==PLAN_SHA
 freeze=ROOT/'test/results/locateanything-w8a16-ar2-pref0-head2-trial-v2-freeze.json';assert sha(freeze)==FREEZE_SHA
 raw=json.loads((REF/'status.json').read_text());plan=json.loads((REF/'case-plan.json').read_text());assert raw['status']=='completed' and raw['trial_recipe_freeze_sha256']==FREEZE_SHA and raw['case_plan_sha256']==PLAN_SHA
 assert len(raw['cases'])==len(plan['cases'])==160
 assert raw['source_sha256']=='2c3cf0f0a8a3f968dfde3275d438969be6ab6227d27a2fb9e6143af39153d33e' and raw['selection_sha256']=='95c72fe2a8283bd0818a5263635c9f5a9a2d9e5062370155ea1c0aea52db7599'
 assert raw['original_parameters']==3517975280 and raw['vision_blocks']==27 and raw['decoder_layers']==36 and raw['original_weights_modified'] is False
 selected_path=BASE/'independent-final-images-v2-head-o2/manifest.json';assert sha(selected_path)==raw['selection_sha256'];selected=json.loads(selected_path.read_text())
 parser=ROOT/'test/model_conversion/validate_locateanything_official_heldout_bpu_v2.py';assert sha(parser)=='616e0504988c3ff480922717f9c18a0538ce3395752d42f4bc554fdfd01cef1b'
 fn=next(n for n in ast.parse(parser.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='parse_response');scope={'re':re};exec(compile(ast.Module(body=[fn],type_ignores=[]),str(parser),'exec'),scope);parse=scope['parse_response']
 promptfile=ROOT/'ai-service/runtime/locateanything_prompt.py';assert sha(promptfile)=='d1adce4fa0c3bc55575b4a0505c050a96b4f633c59e2420497a3bb29b082f420'
 sys.path.insert(0,str(promptfile.parent));from locateanything_prompt import LocateAnythingPrompt
 prompt=LocateAnythingPrompt(BASE/'tokenizer-original-v1.json',TOKEN_SHA);cases=[];unique={};failures=[];corrected=[];pcroot=Path('/work/official-llm-v1/independent-final-native-reference-v2-head-o2')
 for n,(c,p) in enumerate(zip(raw['cases'],plan['cases'])):
  assert n==c['index']==p['index'] and all(c[k]==v for k,v in p.items());arrays={};paths={}
  for key in ['pixels','grid','ids']:
   relative=Path(c[key]).relative_to(pcroot);f=REF/relative;assert f.resolve().is_relative_to(REF.resolve()) and sha(f)==c[key+'_sha256'];arrays[key]=np.load(f,allow_pickle=False);paths[key]=str(relative);unique[str(relative)]=c[key+'_sha256']
  assert arrays['pixels'].shape==(512,3,14,14) and arrays['pixels'].dtype==np.float32 and np.isfinite(arrays['pixels']).all()
  assert arrays['grid'].tolist()==[[16,32]] and np.array_equal(prompt.encode(c['query'],256,'slow'),arrays['ids']) and len(arrays['ids'])+256<=512
  parsed=parse(c['response']);typevalid=not parsed['points'] if c['kind']=='box' else not parsed['boxes'];terminal='<|im_end|>' in c['response'];assert terminal==c['terminal']
  eligible=terminal and not parsed['malformed_blocks'] and typevalid
  if not eligible:failures.append(n)
  if not c['coordinate_contract_valid'] and eligible:corrected.append(n);assert parsed['explicit_empty_boxes']>0
  item=dict(c);item.update(paths,reference=parsed,reference_eligible=eligible,reference_terminal=terminal,reference_geometry_type_valid=typevalid,raw_coordinate_contract_valid=c['coordinate_contract_valid'])
  cases.append(item)
 assert len(unique)==224 and not corrected
 assert {c['image_id'] for c in cases}=={e['image_id'] for e in selected['entries']} and not {c['image_id'] for c in cases}&set(selected['excluded_ids'])
 assert sum(c['kind']=='box' for c in cases)==144 and sum(c['kind']=='point' for c in cases)==16
 assert all(c['parsed_response']==c['reference'] and c['coordinate_contract_valid']==(not c['reference']['malformed_blocks'] and c['reference_geometry_type_valid']) for c in cases)
 report=dict(status='new_head_trial_native_reference_validated_with_explicit_coverage',created=time.time(),source_sha256=sha(__file__),raw_sha256=RAW_SHA,case_plan_sha256=PLAN_SHA,trial_recipe_freeze_sha256=FREEZE_SHA,parser_sha256=sha(parser),tokenizer_sha256=TOKEN_SHA,required_candidate_cases=160,required_candidate_indices=list(range(160)),image_count=32,box_cases=144,point_cases=16,reference_eligible_cases=160-len(failures),reference_eligible_box_cases=sum(c['reference_eligible'] and c['kind']=='box' for c in cases),reference_eligible_point_cases=sum(c['reference_eligible'] and c['kind']=='point' for c in cases),reference_eligible_indices=[c['index'] for c in cases if c['reference_eligible']],reference_ineligible_indices=failures,raw_false_invalid_empty_indices=corrected,all224_array_files_hash_checked=True,all160_board_prompt_ids_exact=True,neural_calls=0,candidate_evaluation_executed=False,candidate_quality_verified=False,release_approved=False,acceptance_policy=dict(all160_candidate_operations_required=True,all_candidate_outputs_terminal_well_formed_and_typevalid_required=True,quality_iou=.9,trial_precision_floor=.45,trial_recall_floor=.45,reference_failure_not_correct_gold=True,report_eligible_gold_coverage=True,report_native_failure_separately=True,no_case_replacement=True,no_threshold_change=True),cases=cases)
 write_new(REF/'reference-index-v3.json',report)
 public={k:v for k,v in report.items() if k!='cases'};public['reference_index_sha256']=sha(REF/'reference-index-v3.json');public['array_file_sha256']=unique;public['native_failure_summary']=[dict(index=i,image_id=cases[i]['image_id'],query=cases[i]['query'],generated_tokens=len(cases[i]['generated_ids']),parsed_boxes=len(cases[i]['reference']['boxes']),malformed_blocks=cases[i]['reference']['malformed_blocks'],terminal=cases[i]['terminal']) for i in failures]
 write_new(ROOT/'test/results/independent-final-native-reference-validation-v2-head-o2.json',public)
 dest=ROOT/'test/results/independent-final-native-reference-v2-head-o2-raw.json';assert not dest.exists();dest.write_bytes((REF/'status.json').read_bytes());assert sha(dest)==RAW_SHA
 assert sha(REF/'status.json')==RAW_SHA and sha(REF/'case-plan.json')==PLAN_SHA
 paths={REF,REF/'status.json',REF/'case-plan.json',REF/'reference-index-v3.json'}
 for relative in unique:paths.add(REF/relative);paths.add((REF/relative).parent)
 for path in paths:assert not path.is_symlink();os.chown(path,1000,1000);os.chmod(path,0o750 if path.is_dir() else 0o640)
 print(json.dumps({k:public[k] for k in ['status','reference_index_sha256','reference_eligible_cases','native_failure_summary','all224_array_files_hash_checked','all160_board_prompt_ids_exact']}))
if __name__=='__main__':main()
