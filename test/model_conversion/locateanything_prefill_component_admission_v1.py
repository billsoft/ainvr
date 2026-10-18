"""Metadata-only same-BC prefill component admission.

The admit function is copied byte-for-byte from actual v130 board-benchmark
SHA40f3ed206a7329ea342763b385d7bf9daf366f6e333bfe188b7b16474119e669.
No BPU construction or runtime/maintenance dependency.
"""
from pathlib import Path
import hashlib,json
BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
ORIGIN=BASE/'official-qwen-group-0-8-w8a16-ar2-pref0-v1-board-package'
PACKAGE=BASE/'official-w8-prefill-o2-v130-board-package'
BASE_MANIFEST_SHA='4a23c4b34a9d25e1d702f731e6ec787f1ae5a265d48e9dfbca1ddee17bebf1f7'
COMPILER_SHA='e3ed149369d804c110271b1b71ecbbe879498595084d7010c69c65a30bca3702'
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def read(p):return json.loads(Path(p).read_text())
def admit(pin):
 assert sha(PACKAGE/'manifest.json')==pin and sha(ORIGIN/'manifest.json')==BASE_MANIFEST_SHA and not PACKAGE.is_symlink()
 m=read(PACKAGE/'manifest.json');old=read(ORIGIN/'manifest.json');assert m['schema']=='locateanything_same_bc_w8_prefill_board_v1' and m['baseline_manifest_sha256']==BASE_MANIFEST_SHA and m['baseline_package']==ORIGIN.name and m['compiler_source_sha256']==COMPILER_SHA and m['first']==0 and m['last']==8 and not m['release_approved'] and not m['whole_model_verified']
 assert m['baseline_profile_optimization']=={'1':2,'256':0} and m['candidate_profile_optimization']=={'1':2,'256':2};assert set(m['files'])=={'model.hbm','disas.json','source-status.json','baseline-status.json','same-bc-provenance.json','ports.json'}
 for name,v in m['files'].items():
  p=PACKAGE/name;assert p.resolve().is_relative_to(PACKAGE) and not p.is_symlink() and p.stat().st_size==v['bytes'] and sha(p)==v['sha256']
 a=read(PACKAGE/'source-status.json');b=read(PACKAGE/'baseline-status.json');assert sha(PACKAGE/'source-status.json')==m['source_status_sha256']=='54ae6c107703bec5a80781f8d442926e638ab710b79bb4c205774f080c75851c';assert sha(PACKAGE/'baseline-status.json')==m['baseline_status_sha256']=='8660122afa575b7eef04ee20770f8bb9623785c12fafa19849584f4e1522b61f' and b==old['source_status']
 assert a['status']==b['status']=='compiled_original_group_shared_profiles_bpu_only' and a['finished'] and a['source_sha256']==COMPILER_SHA and a['optimization']==2 and a['compile_jobs']==1 and a['bpu_only'] and not a['recalibration_executed'] and not a['weights_or_graph_changed'] and not a['neural_cpu_or_gpu_production_fallback']
 for k in ['origin_status_sha256','origin_hbm_sha256','first','last','layer_count','weight_bits','attention_activation_bits','calibration','original_parameter_hashes','original_model_code_sha256','calibration_source_status_sha256','calibration_provenance','ranges','range_hash','cache_input_layout','high_precision_qpp','original_norm_epsilon_preserved','quantized_io_removed']:assert a[k]==b[k],k
 assert sha(PACKAGE/'model.hbm')==a['hbm_sha256']==m['candidate_hbm_sha256']=='4005bf1615063153d1ad0a18706090791fde0116451b3a4173fc3a220adaca94' and sha(ORIGIN/'official-q8/model.hbm')==b['hbm_sha256']==m['baseline_hbm_sha256']=='c5d4205c62bae529c86635c1f816b5c7e936f59ba6cd3aec674e685ef9aec399'
 profiles=read(PACKAGE/'ports.json');assert profiles==old['profiles'];provenance=read(PACKAGE/'same-bc-provenance.json');assert provenance['same_AR_hbo'] and provenance['same_quantization_and_original_parameters']
 for seq in [1,256]:
  pa=next(x for x in a['profiles'] if x['sequence_capacity']==seq);pb=next(x for x in b['profiles'] if x['sequence_capacity']==seq);v=provenance['components'][str(seq)]
  assert pa['converted_bc_sha256']==pb['converted_bc_sha256']==v['converted_bc_sha256'] and pa['ports_sha256']==pb['ports_sha256']==v['ports_sha256'] and pa['regression']==pb['regression'] and len(pa['regression'])==4 and pa['hbo_sha256']==v['hbo_sha256']
  if seq==1:assert pa['hbo_sha256']==pb['hbo_sha256']=='589141b70bc36fd24887c84dc6a16310bfbdb93cb588e5b5c1f86f6e9115fec8'
  else:assert pa['converted_bc_sha256']=='4b49df57829d582dcb61712f365087218e59cc49192e4cb75f30c5d2974e4b2d' and pa['hbo_sha256']=='3dd4c2895738964a501e0342d38cfabb287e4dbf16eaff070209bbc66258d780'
  for case in range(4):
   for stem,count in [('input',22),('compiler',19)]:
    for i in range(count):
     name=f's{seq}/case-{case:02d}/{stem}-{i:02d}.npy';p=ORIGIN/name;assert p.stat().st_size==old['files'][name]['bytes'] and sha(p)==old['files'][name]['sha256']==provenance['fixture_sha256'][name]
 disas=read(PACKAGE/'disas.json');assert len(disas['graphs'])==2 and {g['name'] for g in disas['graphs']}=={p['name'] for p in profiles} and all(n['device']=='DEVICE_CATEGORY_BPU' for g in disas['graphs'] for n in g['nodes'])
 return m,profiles
