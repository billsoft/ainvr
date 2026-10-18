"""Package separately optimized head with exact original fixture/IO provenance."""
from pathlib import Path
import json,hashlib,tarfile,shutil
SOURCE=Path('/opt/locate-official-full-head-w8-o2-v1');ORIGIN=Path('/opt/locate-official-full-head-w8-v1');OUT=Path('/work/official-llm-v1/official-full-head-w8-o2-v1-board-package')
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
r=json.loads((SOURCE/'status.json').read_text());old=json.loads((ORIGIN/'status.json').read_text());ports=json.loads((ORIGIN/'ports.json').read_text())
assert r['status']=='compiled_same_bc_full_head_o2_bpu_only' and r['bpu_only'] and r['source_sha256']=='eeb7659eae7366b0bf6c517dbde40c069b9f3c446dcf186fd71834034bbd7545' and r['optimization']==r['compile_jobs']==2 and not r['recalibration_executed'] and not r['weights_or_graph_changed'] and not r['current_frozen_trial_recipe_changed']
assert sha(ORIGIN/'status.json')==r['origin_status_sha256']=='dd2054442733aeb169ab634ad5749bcb5bf3cf26651cf2b76978bc2f4d2aaf55'
assert sha(SOURCE/'converted.bc')==sha(ORIGIN/'converted.bc')==r['converted_bc_sha256']=='e0353110deeaf22f7d89ed462be8c850e7bd53a2bc1b5b48b5372e6abdf1678e'
assert sha(SOURCE/'ports.json')==sha(ORIGIN/'ports.json') and sha(SOURCE/'model.hbm')==r['hbm_sha256']
assert old['status']=='compiled_bpu_only' and old['vocabulary']==152681 and old['weights_bits']==8 and len(old['regression'])==8
archive=OUT.with_suffix('.tar');report=OUT.with_suffix('.json');assert not OUT.exists() and not archive.exists() and not report.exists();OUT.mkdir();files={}
def copy(p,n):
 q=OUT/n;q.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,q);files[n]=dict(bytes=q.stat().st_size,sha256=sha(q))
for p,n in [(SOURCE/'model.hbm','official-q8/model.hbm'),(SOURCE/'status.json','source-status.json'),(ORIGIN/'status.json','origin-status.json'),(SOURCE/'disas.json','disas.json'),(SOURCE/'ports.json','ports.json')]:copy(p,n)
for case in range(8):
 for label,count in [('input',1),('compiler',2)]:
  for i in range(count):
   n=f'case-{case:02d}/{label}-{i:02d}.npy';assert sha(SOURCE/'fixtures'/n)==sha(ORIGIN/'fixtures'/n);copy(SOURCE/'fixtures'/n,n)
m=dict(schema='locateanything_official_head_optimization_board_v1',source_status=r,source_status_sha256=sha(SOURCE/'status.json'),original_source_status=old,original_status_sha256=sha(ORIGIN/'status.json'),component_kind='full_head',case_count=8,models=[dict(name='official-q8',hbm_sha256=r['hbm_sha256'])],inputs=ports['inputs'],outputs=ports['outputs'],files=files,whole_model_verified=False,release_approved=False,current_frozen_trial_recipe_changed=False)
(OUT/'manifest.json').write_text(json.dumps(m,indent=2)+'\n')
with tarfile.open(archive,'w') as t:
 for p in sorted(OUT.rglob('*')):
  if p.is_file():t.add(p,arcname=p.relative_to(OUT),recursive=False)
d=dict(status='packaged_same_bc_head_o2_board_validation_pending',archive_bytes=archive.stat().st_size,archive_sha256=sha(archive),manifest_sha256=sha(OUT/'manifest.json'),source_status_sha256=sha(SOURCE/'status.json'),original_status_sha256=sha(ORIGIN/'status.json'),payload_files=len(files),current_frozen_trial_recipe_changed=False,release_approved=False);report.write_text(json.dumps(d,indent=2)+'\n');print(json.dumps(d))
