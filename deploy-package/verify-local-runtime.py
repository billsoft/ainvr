#!/usr/bin/env python3
"""Verify supported AINVR runtime model assets are complete on board storage.
Build trees, original weights, research candidates and history are not runtime assets.
"""
import argparse,hashlib,json
from pathlib import Path
ROOT=Path('/home/sunrise/ainvr')
def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for block in iter(lambda:f.read(8*1024*1024),b''):h.update(block)
 return h.hexdigest()
def check_local(p,device):
 assert p.is_file() and p.stat().st_dev==device, 'Missing or externally stored runtime: '+str(p)
 return p.stat().st_size
def verify(root):
 root=Path(root);device=root.stat().st_dev;models=root/'ai-service/models';rows=[]
 def verify_file(p,expected=None):
  size=check_local(p,device);actual=digest(p)
  if expected is not None:assert actual==expected,'Checksum mismatch: '+str(p)
  rows.append({'path':str(p.relative_to(models)),'bytes':size,'sha256':actual})
 qwen=models/'llm/qwen3vl-4b-review-v3';manifest=qwen/'llm-package.ainvr.json'
 check_local(manifest,device);package=json.loads(manifest.read_text())
 for f in package['files']:
  p=qwen/f['path'];assert p.resolve().is_relative_to(qwen.resolve()),'Out-of-package path'
  assert p.stat().st_size==f['bytes'];verify_file(p,f['sha256'])
 verify_file(manifest)
 for name in ['gpen_bfr_256.hbm','derived/s100p/yolo26x.hbm','derived/s100p/yolo26x-face.hbm','derived/s100p/yoloe-26x.hbm','derived/s100p/yoloe-26x-32.hbm']:
  hbm=models/name;sidecar=Path(str(hbm)+'.ainvr.json');check_local(sidecar,device);d=json.loads(sidecar.read_text());verify_file(hbm,d['hbm_sha256'])
  if 'dynamic_text' in d:
   t=d['dynamic_text']
   for k in ['text_hbm','reprta_hbm']:verify_file(Path(t[k]),t[k+'_sha256'])
   assets=Path(t['tokenizer_assets']);verify_file(assets/'simple_tokenizer.py',t['tokenizer_source_sha256']);verify_file(assets/'bpe_simple_vocab_16e6.txt.gz',t['tokenizer_bpe_sha256'])
   check_local(Path(t['tokenizer_python']),device)
 # Reject even an otherwise unused dangling SSD model entry: discovery must not
 # advertise a research model that cannot work without the removable disk.
 for p in models.rglob('*'):
  if p.is_symlink():assert p.exists() and p.stat().st_dev==device,'External or broken model entry: '+str(p)
 return {'passed':True,'qwen_package_sha256':digest(manifest),'hbm_files':len(list(models.rglob('*.hbm'))),'verified_assets':rows}
def main():
 a=argparse.ArgumentParser(description=__doc__);a.add_argument('--root',type=Path,default=ROOT);a.add_argument('--report',type=Path);args=a.parse_args();report=verify(args.root)
 if args.report:args.report.write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps({k:v for k,v in report.items() if k!='verified_assets'}))
if __name__=='__main__':main()
