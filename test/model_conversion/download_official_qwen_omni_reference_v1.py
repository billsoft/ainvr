"""Download official S100P Omni benchmark assets only; no install or inference."""
from pathlib import Path
import hashlib,json,os,shutil,subprocess,time,traceback,urllib.request
ROOT=Path('/home/sunrise/ainvr')
BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/official-qwen-omni-3b-v1')
REPORT=ROOT/'test/results/official-qwen-omni-download-v1.json'
URL='https://d-robotics-aitoolchain.oss-cn-beijing.aliyuncs.com/llm_s100/1.0.0/models/'
EXPECTED={'Qwen2.5_Omni_3B_Visual.hbm':'1cb192748f9f229ae3883ade82fca292','Qwen2.5_Omni_3B_Text.hbm':'5f6012d2339c5813795bd5796abf2ed7','Qwen2.5_Omni_3B_Audio.hbm':'473465668046a759b99912d0d92836e9','embed_tokens.bin':'4295ce4512f3e955893bd6a74c639a16'}
assert not REPORT.exists()
r=dict(status='checking',started=time.time(),pid=os.getpid(),source='Official S100 SDK1.0.0 resolve_model_nash-m.txt and published md5sum.txt',assets=[],production_services_modified=False,inference_executed=False)
def save():
 p=REPORT.with_suffix('.json.tmp');p.write_text(json.dumps(r,indent=2)+'\n');p.replace(REPORT)
try:
 save();assert shutil.disk_usage(BASE.parent).free>20*1024**3
 BASE.mkdir(exist_ok=False);(BASE/'model').mkdir()
 published=urllib.request.urlopen(URL+'md5sum.txt',timeout=30).read();(BASE/'published-md5sum.txt').write_bytes(published)
 hashes={line.split()[1]:line.split()[0] for line in published.decode().splitlines() if line.strip()}
 assert all(hashes[name]==value for name,value in EXPECTED.items())
 for name,expected in EXPECTED.items():
  target=BASE/'model'/name;temporary=target.with_suffix(target.suffix+'.partial');assert not target.exists()
  r.update(status='downloading',current=name);save()
  log=BASE/(name+'.download.log')
  with log.open('xb') as stream:
   child=subprocess.Popen(['curl','--fail','--location','--retry','2','--connect-timeout','20','--max-time','1800','--limit-rate','20M','--continue-at','-','--output',str(temporary),URL+name],stdin=subprocess.DEVNULL,stdout=stream,stderr=subprocess.STDOUT)
   r.update(child_pid=child.pid,child_start_ticks=Path(f'/proc/{child.pid}/stat').read_text().split(') ',1)[1].split()[19]);save()
   assert child.wait(timeout=1900)==0,'Asset download failed; partial retained'
  md5=hashlib.md5();sha=hashlib.sha256()
  with temporary.open('rb') as stream:
   for block in iter(lambda:stream.read(4*1024**2),b''):md5.update(block);sha.update(block)
  assert md5.hexdigest()==expected,'Official MD5 mismatch; do not use this asset'
  temporary.replace(target);r['assets'].append(dict(name=name,url=URL+name,bytes=target.stat().st_size,official_md5=expected,sha256=sha.hexdigest()));save()
 r.update(status='downloaded_and_checksums_verified',current=None,finished=time.time());save()
except BaseException:
 r.update(status='failed',error=traceback.format_exc(),finished=time.time());save();raise
print(json.dumps(r))
