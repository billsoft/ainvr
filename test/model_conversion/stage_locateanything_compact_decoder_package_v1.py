"""Stage the complete compact decoder archive with verified internal HBM hard links.
Transport integrity only;does not certify model quality,hardware execution or UI.
"""
from pathlib import Path,PurePosixPath
import argparse,hashlib,json,os,pwd,shutil,tarfile,time,traceback
BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
RESULTS=Path('/home/sunrise/ainvr/test/results')
PACKAGER='7bf9d2c776ba65acac0917dfb33b154c69dac551ac5a24079de272ffeb94b5bd'
BUILDER='dc65fb759764d89a9c026ae05a3171c0931888343cf1dca3124f9439e3f4067d'
FILES={'model.hbm','status.json','ports.json','compiler-status.json','disas.json'}
def digest(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(1024**2),b''):h.update(b)
 return h.hexdigest()
def canonical(name):
 p=PurePosixPath(name)
 assert name==str(p) and name and not p.is_absolute() and '..' not in p.parts and '\\' not in name
 return p

def inspect(tf,manifest_sha):
 members=tf.getmembers();names=[m.name for m in members]
 assert len(set(names))==len(names) and len(names)==41
 table={m.name:m for m in members}
 assert all(canonical(n) for n in names)
 m=table['manifest.json'];assert m.isreg() and 0<m.size<4*1024**2
 raw=tf.extractfile(m).read();assert hashlib.sha256(raw).hexdigest()==manifest_sha
 manifest=json.loads(raw)
 assert manifest['schema']=='compact_original_decoder_groups_v1' and manifest['status']=='complete_compact_decoder_profiles'
 assert manifest['source_sha256']==PACKAGER and manifest['builder_sha256']==BUILDER
 assert manifest['original_decoder_layers']==36 and manifest['profile_sequence_capacities']=={'ar':1,'prefill':1}
 assert set(manifest['required_profiles'])=={'ar','prefill'} and manifest['enabled_generation_modes']==['slow']
 assert manifest['evaluation_only'] is True and manifest['release_approved'] is False
 entries=manifest['components'];assert len(entries)==8
 expected={'manifest.json':manifest_sha};groups={};required={(i,i+8,p) for i in (0,9,18,27) for p in ['ar','prefill']}
 assert {(e['start'],e['end'],e['profile']) for e in entries}==required
 for e in entries:
  start,end,profile=e['start'],e['end'],e['profile'];directory=f'group-{start:02d}-{end:02d}-{profile}'
  assert e['directory']==directory and e['sequence']==1 and set(e['files'])==FILES
  assert e['hbm_sha256']==e['files']['model.hbm']
  for f,sha in e['files'].items():
   assert isinstance(sha,str) and len(sha)==64 and set(sha)<=set('0123456789abcdef')
   expected[directory+'/'+f]=sha
  groups[directory]=(start,end)
 assert set(expected)==set(table)
 verified=set();links=[]
 for m in members:
  if m.isreg():assert m.size>=0
  else:
   assert m.islnk() and m.name.endswith('/model.hbm') and m.size==0
   target=canonical(m.linkname);assert str(target) in verified and table[str(target)].isreg()
   assert target.name=='model.hbm' and groups[str(target.parent)]==groups[str(canonical(m.name).parent)]
   assert expected[m.name]==expected[str(target)]
   links.append(dict(name=m.name,target=str(target)))
  verified.add(m.name)
 return manifest,members,expected,links

def extract(tf,members,expected,destination,uid,gid):
 assert destination.is_dir() and not destination.is_symlink() and not any(destination.iterdir())
 for m in members:
  target=destination.joinpath(*canonical(m.name).parts)
  target.parent.mkdir(exist_ok=True)
  assert target.parent.resolve().is_relative_to(destination.resolve()) and not target.exists() and not target.is_symlink()
  if m.islnk():
   source=destination.joinpath(*canonical(m.linkname).parts);assert source.is_file() and not source.is_symlink()
   os.link(source,target)
  else:
   with target.open('xb') as output,tf.extractfile(m) as source:shutil.copyfileobj(source,output,1024**2)
  assert target.stat().st_size==(tf.getmember(m.linkname).size if m.islnk() else m.size)
  assert digest(target)==expected[m.name]
  target.chmod(0o644);os.chown(target,uid,gid)
 for d in [destination,*[p for p in destination.iterdir() if p.is_dir()]]:d.chmod(0o755);os.chown(d,uid,gid)

def main():
 p=argparse.ArgumentParser();p.add_argument('--archive',type=Path,required=True);p.add_argument('--archive-sha256',required=True);p.add_argument('--manifest-sha256',required=True);p.add_argument('--name',required=True);p.add_argument('--report',type=Path,required=True);a=p.parse_args()
 assert os.getuid()==0 and a.report.parent.resolve()==RESULTS and not a.report.exists()
 assert a.archive.parent.resolve()==BASE and not a.archive.is_symlink() and a.archive.is_file()
 assert a.name.startswith('compact-decoder-') and a.name.replace('-','').isalnum()
 target=BASE/a.name;temp=BASE/('.'+a.name+'.staging-'+str(os.getpid()))
 assert not target.exists() and not target.is_symlink() and not temp.exists()
 r=dict(status='checking',source_sha256=digest(__file__),started=time.time(),neural_calls=0,contract_created=False,release_approved=False,package_published=False)
 try:
  assert digest(a.archive)==a.archive_sha256
  with tarfile.open(a.archive,'r:') as tf:
   manifest,members,expected,links=inspect(tf,a.manifest_sha256)
   assert shutil.disk_usage(BASE).free>sum(m.size for m in members)+1024**3
   temp.mkdir(mode=0o750);account=pwd.getpwnam('sunrise');assert account.pw_uid==1000
   extract(tf,members,expected,temp,account.pw_uid,account.pw_gid)
  assert not target.exists() and not target.is_symlink();temp.rename(target)
  r.update(status='complete_decoder_package_staged',package_published=True,target=str(target),manifest_sha256=a.manifest_sha256,archive_sha256=a.archive_sha256,verified_files=len(expected),verified_internal_hbm_links=links)
 except BaseException:r.update(status='failed',error=traceback.format_exc(),retained_partial_directory=str(temp) if temp.exists() else None);raise
 finally:
  r['finished']=time.time();a.report.write_text(json.dumps(r,indent=2)+'\n')
 print(json.dumps(r))
if __name__=='__main__':main()
