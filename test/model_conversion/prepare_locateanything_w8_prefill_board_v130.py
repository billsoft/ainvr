"""Reuse the historical terminal same-BC prefillO2 HBM,without recompiling.

AR HBO is byte-identical to the installed baseline;both original input/compiler
fixtures and quantization provenance must match. Package shares files on SSD.
"""
from pathlib import Path
import hashlib,json,os,shutil,time
STAGE=Path('/work/official-llm-v1');SOURCE=Path('/opt/locate-official-qwen-group-0-8-w8a16-o2-v1');BASELINE=Path('/opt/locate-official-qwen-group-0-8-w8a16-ar2-pref0-v1');OUT=Path('/opt/locate-official-w8-prefill-o2-v130-board-package')
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def read(p):return json.loads(Path(p).read_text())
def main():
 assert not OUT.exists();assert sha(SOURCE/'status.json')=='54ae6c107703bec5a80781f8d442926e638ab710b79bb4c205774f080c75851c' and sha(BASELINE/'status.json')=='8660122afa575b7eef04ee20770f8bb9623785c12fafa19849584f4e1522b61f'
 a=read(SOURCE/'status.json');b=read(BASELINE/'status.json');assert a['status']==b['status']=='compiled_original_group_shared_profiles_bpu_only' and a['finished'] and a['source_sha256']=='e3ed149369d804c110271b1b71ecbbe879498595084d7010c69c65a30bca3702' and a['optimization']==2 and a['compile_jobs']==1 and a['bpu_only'] and not a['recalibration_executed'] and not a['weights_or_graph_changed'] and not a['neural_cpu_or_gpu_production_fallback']
 assert b['profile_optimization']=={'1':2,'256':0} and sha(SOURCE/'model.hbm')==a['hbm_sha256']=='4005bf1615063153d1ad0a18706090791fde0116451b3a4173fc3a220adaca94' and sha(BASELINE/'model.hbm')==b['hbm_sha256']=='c5d4205c62bae529c86635c1f816b5c7e936f59ba6cd3aec674e685ef9aec399'
 for k in ['origin_status_sha256','origin_hbm_sha256','first','last','layer_count','weight_bits','attention_activation_bits','calibration','original_parameter_hashes','original_model_code_sha256','calibration_source_status_sha256','calibration_provenance','ranges','range_hash','cache_input_layout','high_precision_qpp','original_norm_epsilon_preserved','quantized_io_removed']:assert a[k]==b[k],k
 assert a['first']==0 and a['last']==8 and a['layer_count']==9 and a['weight_bits']==8 and a['attention_activation_bits']==16
 fixtures={};profiles=[];components={}
 for seq in [1,256]:
  pa=next(x for x in a['profiles'] if x['sequence_capacity']==seq);pb=next(x for x in b['profiles'] if x['sequence_capacity']==seq);sa=SOURCE/f's{seq}';sb=BASELINE/f's{seq}'
  assert pa['status']==pb['status']=='compiled_hbo' and pa['regression']==pb['regression'] and len(pa['regression'])==4 and pa['range_hash']==pb['range_hash']
  for name,field in [('converted.bc','converted_bc_sha256'),('ports.json','ports_sha256')]:assert sha(sa/name)==sha(sb/name)==pa[field]==pb[field]
  if seq==1:assert sha(sa/'model.hbo')==sha(sb/'model.hbo')==pa['hbo_sha256']==pb['hbo_sha256']=='589141b70bc36fd24887c84dc6a16310bfbdb93cb588e5b5c1f86f6e9115fec8'
  else:assert sha(sa/'model.hbo')==pa['hbo_sha256']=='3dd4c2895738964a501e0342d38cfabb287e4dbf16eaff070209bbc66258d780'
  components[str(seq)]={k:pa[k] for k in ['converted_bc_sha256','ports_sha256','hbo_sha256']};profiles.append(dict(sequence=seq,**read(sa/'ports.json')))
  for c in range(4):
   for stem,count in [('input',22),('compiler',19)]:
    for i in range(count):
     name=f's{seq}/case-{c:02d}/{stem}-{i:02d}.npy';assert sha(SOURCE/name)==sha(BASELINE/name);fixtures[name]=sha(SOURCE/name)
 disas=read(SOURCE/'disas.json');assert {g['name'] for g in disas['graphs']}=={p['name'] for p in profiles} and all(n['device']=='DEVICE_CATEGORY_BPU' for g in disas['graphs'] for n in g['nodes'])
 OUT.mkdir()
 for name,path in [('model.hbm',SOURCE/'model.hbm'),('disas.json',SOURCE/'disas.json'),('source-status.json',SOURCE/'status.json'),('baseline-status.json',BASELINE/'status.json')]:
  try:os.link(path,OUT/name)
  except OSError:shutil.copyfile(path,OUT/name)
 (OUT/'ports.json').write_text(json.dumps(profiles,indent=2)+'\n');(OUT/'same-bc-provenance.json').write_text(json.dumps(dict(components=components,fixture_sha256=fixtures,same_AR_hbo=True,same_quantization_and_original_parameters=True),indent=2)+'\n')
 m=dict(schema='locateanything_same_bc_w8_prefill_board_v1',created=time.time(),packager_sha256=sha(__file__),compiler_source_sha256=a['source_sha256'],source_status_sha256=sha(SOURCE/'status.json'),baseline_status_sha256=sha(BASELINE/'status.json'),candidate_hbm_sha256=sha(OUT/'model.hbm'),baseline_hbm_sha256=b['hbm_sha256'],baseline_package='official-qwen-group-0-8-w8a16-ar2-pref0-v1-board-package',baseline_manifest_sha256='4a23c4b34a9d25e1d702f731e6ec787f1ae5a265d48e9dfbca1ddee17bebf1f7',first=0,last=8,baseline_profile_optimization={'1':2,'256':0},candidate_profile_optimization={'1':2,'256':2},files={p.name:dict(bytes=p.stat().st_size,sha256=sha(p)) for p in OUT.iterdir() if p.is_file()},whole_model_verified=False,release_approved=False,actual_board_verified=False)
 (OUT/'manifest.json').write_text(json.dumps(m,indent=2)+'\n');print(json.dumps(dict(status='historical_prefill_O2_packaged_not_board_qualified',manifest_sha256=sha(OUT/'manifest.json'),hbm_sha256=m['candidate_hbm_sha256'],files=len(m['files']))))
if __name__=='__main__':main()
