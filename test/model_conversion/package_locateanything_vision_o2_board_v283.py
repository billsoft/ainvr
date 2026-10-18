"""Finalize the board SSD package for the same-BC MoonViT27 O2 candidate.

Input is an incoming directory holding the PC build status, linked HBM and
disassembly. The HBM hash must match the build status, every graph must be BPU
and program names/ports are inherited from the deployed O0 package. No neural call.
"""
from pathlib import Path
import hashlib,json,os,sys
BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
O0=BASE/'official-vision-all27-native-v1-board-package';O0_MANIFEST='e99a294b02082fdb81c9e0f0ad64ce6a79e54c5dc7a1aee6767b7f085e8b26b3'
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
incoming=BASE/'vision-all27-o2-v283-incoming';out=BASE/'vision-all27-o2-v283-board-package'
assert incoming.is_dir() and not out.exists() and os.getuid()==0
s=json.loads((incoming/'build-status.json').read_text());assert s['status']=='compiled_same_bc_vision_o2_not_board_qualified' and s['bpu_only'] and len(s['components'])==27
assert sha(incoming/'model.hbm')==s['hbm_sha256'] and (incoming/'model.hbm').stat().st_size==s['hbm_bytes'] and sha(incoming/'disas.json')==s['disas_sha256']
assert sha(O0/'manifest.json')==O0_MANIFEST;ref=json.loads((O0/'manifest.json').read_text())
disas=json.loads((incoming/'disas.json').read_text());assert sorted(g['name'] for g in disas['graphs'])==sorted(p['name'] for p in ref['programs'])
assert all(g['nodes'] and all(n['device']=='DEVICE_CATEGORY_BPU' for n in g['nodes']) for g in disas['graphs'])
assert [c['name'] for c in s['components']]==[p['name'] for p in ref['programs']]
out.mkdir();(out/'official-q8').mkdir()
os.rename(incoming/'model.hbm',out/'official-q8/model.hbm');os.rename(incoming/'disas.json',out/'disas.json');os.rename(incoming/'build-status.json',out/'build-status.json')
files={n:dict(bytes=(out/n).stat().st_size,sha256=sha(out/n)) for n in ['official-q8/model.hbm','disas.json','build-status.json']}
assert files['official-q8/model.hbm']['sha256']==s['hbm_sha256']
m=dict(schema='locateanything_vision_all27_o2_board_v283',component_kind='vision_all27_same_bc_o2',reference_root=O0.name,reference_manifest_sha256=O0_MANIFEST,
 o0_hbm_sha256='8020083c93cea4d1e3d00e7c316a8b268b05c598c2b4b601088e3a13c9961da1',o2_hbm_sha256=s['hbm_sha256'],programs=ref['programs'],files=files,
 build_source_sha256=s['source_sha256'],compile_arguments=s['compile_arguments'],whole_model_verified=False,release_approved=False)
(out/'manifest.json').write_text(json.dumps(m,indent=2)+'\n');incoming.rmdir()
for root,dirs,fs in os.walk(out):
 for n in dirs+fs:os.chown(os.path.join(root,n),1000,1000)
os.chown(out,1000,1000)
print(json.dumps(dict(status='packaged',manifest_sha256=sha(out/'manifest.json'),o2_hbm_sha256=s['hbm_sha256'])))
