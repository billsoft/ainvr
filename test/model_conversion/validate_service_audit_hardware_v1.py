"""Serial bounded BPU/VPU regression, AI-only pause and mandatory fresh recovery."""
from pathlib import Path
import hashlib,json,os,signal,subprocess,time,traceback,urllib.request
import numpy as np

ROOT=Path('/home/sunrise/ainvr')
BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
OUT=ROOT/'test/results/service-audit-hardware-v1.json'
WORK=BASE/'service-audit-hardware-v1'
BUILD=ROOT/'out/build/ai-s100p'
assert not OUT.exists() and not WORK.exists()
WORK.mkdir(mode=0o700)
key=json.loads((ROOT/'data/ai/config_overlay.json').read_text())['server']['api_key']
channel='2baec0a3-9941-47dc-b1bd-d3d284488097'
r=dict(status='running',started=time.time(),recorder_or_ingest_or_miners_signalled=False,
       production_restored=False,results=[],source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
def persist():
    p=OUT.with_suffix('.json.tmp');p.write_text(json.dumps(r,indent=2)+'\n');p.replace(OUT)
def unit(name):
    return subprocess.run(['systemctl','is-active',name],capture_output=True,text=True,timeout=10).stdout.strip()
def snapshot():
    def get(path):
        req=urllib.request.Request('http://127.0.0.1:8000'+path,headers={'X-Api-Key':key})
        return json.load(urllib.request.urlopen(req,timeout=5))
    c=get('/api/v1/channels/'+channel);a=get('/api/v1/channels/'+channel+'/results/latest')
    return dict(checked=time.time(),inference_count=c['stats']['inference_count'],
                consecutive_errors=c['stats']['consecutive_errors'],timestamp=a.get('result',{}).get('timestamp'))
def interrupt(signum,frame):raise RuntimeError('Owned hardware validator interrupted')
signal.signal(signal.SIGTERM,interrupt);signal.signal(signal.SIGHUP,interrupt)
active=False
try:
    active=unit('ainvr-ai')=='active';assert active
    r['before']=snapshot();r['pause_started']=time.time();persist()
    subprocess.run(['systemctl','stop','ainvr-ai'],check=True,timeout=45)
    assert unit('ainvr-ai')=='inactive'
    deadline=time.monotonic()+120
    def run(args,name):
        remaining=deadline-time.monotonic();assert remaining>0,'Hardware test deadline exceeded'
        x=subprocess.run(args,capture_output=True,timeout=min(30,remaining),env=dict(os.environ,LD_LIBRARY_PATH='/usr/hobot/lib'))
        (WORK/(name+'.stdout')).write_bytes(x.stdout);(WORK/(name+'.stderr')).write_bytes(x.stderr)
        assert x.returncode==0,'Hardware command failed: '+name
        return x
    model=ROOT/'ai-service/models/gpen_bfr_256.hbm'
    x=run(['runuser','-u','sunrise','--',str(BUILD/'ainvr_bpu_probe'),str(model),'2'],'bpu')
    text=x.stdout.decode();d=json.loads(text[text.index('{\n'):]);assert d['iterations']==2 and d['output_elements']>0
    r['results'].append(dict(kind='BPU',iterations=2,test_input='zero-filled execution control,not model quality',model_sha256=hashlib.sha256(model.read_bytes()).hexdigest(),elapsed_ms=d['elapsed_ms'],finite_outputs=True,uid=1000));persist()
    fixtures=ROOT/'test/runtime/vpu-poc-20261011-171503-588585'
    for name in ['h264-open0','h264-open1','hevc-open0','hevc-open1']:
        source=fixtures/(name+'.mp4');raw=WORK/(name+'-hardware.nv12');report=WORK/(name+'.json')
        run([str(BUILD/'service_audit_vpu_poc_probe'),str(source),str(raw),str(report)],name+'-vpu')
        # Independent software decoding is an explicitly labeled test oracle.
        x=run(['/usr/bin/ffmpeg','-v','error','-i',str(source),'-vsync','0','-pix_fmt','nv12','-f','rawvideo','-'],name+'-reference')
        got=np.fromfile(raw,dtype=np.uint8).reshape(36,-1);want=np.frombuffer(x.stdout,dtype=np.uint8).reshape(36,-1)
        assert got.shape==want.shape==(36,640*360*3//2)
        errors=np.abs(got.astype(np.int16)-want.astype(np.int16)).mean(axis=1);assert float(errors.max())<1
        x=run(['/usr/bin/ffprobe','-v','error','-select_streams','v','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',str(source)],name+'-pts-reference')
        expected=json.loads(x.stdout)['frames'];actual=json.loads(report.read_text())['frames']
        assert len(actual)==len(expected)==36 and len({f['token'] for f in actual})==36
        assert all(abs(a['pts_ns']-round(float(b['best_effort_timestamp_time'])*1e9))<=501 for a,b in zip(actual,expected))
        r['results'].append(dict(kind='VPU',fixture=name,source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),frames=36,source_pts_match=True,pixel_mae_max=float(errors.max())));persist()
    r['hardware_passed']=True
except BaseException:
    r.update(status='failed',error=traceback.format_exc())
finally:
    if active:
        try:
            subprocess.run(['systemctl','start','ainvr-ai'],check=True,timeout=45)
            deadline=time.monotonic()+40;first=None
            while time.monotonic()<deadline:
                try:
                    current=snapshot()
                    if first is None:first=current
                    if current['inference_count']>first['inference_count'] and current['consecutive_errors']==0 and current['timestamp'] and time.time()-current['timestamp']<10:
                        r.update(production_restored=True,after_first=first,after=current);break
                except Exception:pass
                time.sleep(.5)
            r['services_after']={u:unit(u) for u in ['ainvr-ai','ainvr-recorder','ainvr-ingest']}
            assert r['production_restored'] and all(x=='active' for x in r['services_after'].values())
        except BaseException:r.update(status='failed',restoration_error=traceback.format_exc())
    if r.get('pause_started'):r['pause_seconds']=time.time()-r['pause_started']
    if r['status']!='failed':r['status']='completed'
    r['finished']=time.time();persist()
assert r['status']=='completed'
print(json.dumps({k:r.get(k) for k in ['status','hardware_passed','production_restored','pause_seconds']}))
