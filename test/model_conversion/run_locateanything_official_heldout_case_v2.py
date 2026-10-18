"""One bounded actual complete-model case,with preflight and finally recovery.

Missing/incompatible full grouped architecture contracts must fail before pausing production.
Capture one case per invocation so production resumes between long requests.
"""
from pathlib import Path
import argparse,hashlib,json,os,signal,subprocess,sys,time,traceback,urllib.request

ROOT=Path('/home/sunrise/ainvr')
BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
VALIDATOR=ROOT/'test/model_conversion/validate_locateanything_official_heldout_bpu_v2.py'
VALIDATOR_SHA='616e0504988c3ff480922717f9c18a0538ce3395752d42f4bc554fdfd01cef1b'
PYTHON=ROOT/'ai-service/runtime/.venv-locateanything/bin/python'
p=argparse.ArgumentParser()
p.add_argument('--contract',type=Path,required=True);p.add_argument('--contract-sha256',required=True)
p.add_argument('--index',type=int,required=True);p.add_argument('--mode',choices=['slow','hybrid','fast'],default='slow')
p.add_argument('--maximum-seconds',type=int,default=180)
p.add_argument('--preflight-out',type=Path,required=True);p.add_argument('--case-out',type=Path,required=True)
p.add_argument('--guard-report',type=Path,required=True)
a=p.parse_args()
assert 0<=a.index<72 and 30<=a.maximum_seconds<=1200
assert a.contract.parent.resolve()==BASE.resolve()
assert all(x.parent.resolve()==(BASE/'official-heldout-board-v1').resolve() and not x.exists() for x in [a.preflight_out,a.case_out])
assert a.preflight_out!=a.case_out and a.guard_report.parent.resolve()==(ROOT/'test/results').resolve() and not a.guard_report.exists()
assert hashlib.sha256(VALIDATOR.read_bytes()).hexdigest()==VALIDATOR_SHA
r=dict(status='preflight',started=time.time(),scope='One actual grouped full27/36/vocabulary independently held-out case;full72case aggregation and deployment still required',
 whole_model_bpu_verified=False,case_index=a.index,mode=a.mode,contract_sha256=a.contract_sha256,
 production_pause_authorized=True,production_pause_started=False,production_restored=False,
 recorder_or_ingest_or_miners_signalled=False,validator_sha256=VALIDATOR_SHA)
child=None;child_ticks=None;was_active=False
def persist():
 t=a.guard_report.with_suffix('.json.tmp');t.write_text(json.dumps(r,indent=2)+'\n');t.replace(a.guard_report)
def interrupted(signum,frame):raise RuntimeError('Owned wrapper interrupted: '+str(signum))
signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGHUP,interrupted)
def unit(name):return subprocess.run(['systemctl','is-active',name],capture_output=True,text=True,timeout=10).stdout.strip()
def owned_child():
 try:
  proc=Path('/proc')/str(child.pid);s=(proc/'stat').read_text().split(') ',1)[1].split()
  return s[19]==child_ticks and int(s[2])==child.pid and str(VALIDATOR).encode() in (proc/'cmdline').read_bytes().split(b'\0')
 except (OSError,ProcessLookupError):return False
def kill_owned():
 if child is not None and child.poll() is None and owned_child():
  os.killpg(child.pid,signal.SIGTERM)
  try:child.wait(timeout=10)
  except subprocess.TimeoutExpired:
   if owned_child():os.killpg(child.pid,signal.SIGKILL)
   child.wait(timeout=10)
def command(out,check_only):
 cmd=['runuser','-u','sunrise','--',str(PYTHON),str(VALIDATOR),'--contract',str(a.contract),'--contract-sha256',a.contract_sha256,
  '--tokenizer',str(BASE/'tokenizer-original-v1.json'),'--reference-root',str(BASE/'official-heldout-reference-v1'),
  '--out',str(out),'--case-indices',str(a.index),'--mode',a.mode,'--maximum-seconds-per-case',str(a.maximum_seconds),'--resident-models','1']
 return cmd+(['--check-only'] if check_only else [])
def run_child(out,check_only,timeout):
 global child,child_ticks
 log=a.guard_report.with_name(a.guard_report.stem+('-preflight.log' if check_only else '-case.log'));assert not log.exists()
 with log.open('xb') as stream:
  child=subprocess.Popen(command(out,check_only),stdin=subprocess.DEVNULL,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
  child_ticks=Path(f'/proc/{child.pid}/stat').read_text().split(') ',1)[1].split()[19]
  r.update(child_pid=child.pid,child_start_ticks=child_ticks,maximum_child_seconds=timeout);persist()
  try:code=child.wait(timeout=timeout)
  except subprocess.TimeoutExpired:
   r['owned_child_timeout']=True;kill_owned();raise RuntimeError('Owned evaluation child exceeded its explicit bound')
 return code,json.loads((out/'status.json').read_text()) if (out/'status.json').exists() else None
try:
 persist()
 code,checked=run_child(a.preflight_out,True,180)
 r['preflight_exit_code']=code
 assert code==0 and checked['status']=='contract_checked' and checked['neural_calls']==0 and checked['component_count']==113 and checked['runtime_uid']==1000,'Complete-contract preflight failed;production must remain running'
 r.update(preflight_passed=True,preflight_seconds=checked['finished']-checked['started'],preflight_report_sha256=hashlib.sha256((a.preflight_out/'status.json').read_bytes()).hexdigest());persist()
 # Load credentials only after complete preflight;never place them in logs/reports.
 key=json.loads((ROOT/'data/ai/config_overlay.json').read_text())['server']['api_key']
 channel='2baec0a3-9941-47dc-b1bd-d3d284488097'
 def snapshot():
  def get(path):
   req=urllib.request.Request('http://127.0.0.1:8000'+path,headers={'X-Api-Key':key})
   return json.load(urllib.request.urlopen(req,timeout=5))
  state=get('/api/v1/channels/'+channel);result=get('/api/v1/channels/'+channel+'/results/latest')
  return dict(checked=time.time(),inference_count=state['stats']['inference_count'],consecutive_errors=state['stats']['consecutive_errors'],latest_timestamp=result.get('result',{}).get('timestamp'))
 was_active=unit('ainvr-ai')=='active';assert was_active
 r['before']=snapshot();r.update(status='actual_case',pause_started=time.time(),production_pause_started=True);persist()
 stop=subprocess.run(['systemctl','stop','ainvr-ai'],capture_output=True,text=True,timeout=45);assert stop.returncode==0 and unit('ainvr-ai')=='inactive'
 # The generation request bound excludes the mandatory second artifact hash
 # check. Budget that measured preflight separately instead of truncating it.
 code,captured=run_child(a.case_out,False,a.maximum_seconds+2*r['preflight_seconds']+30)
 r['case_exit_code']=code
 assert code==0 and captured['status']=='completed' and captured['runtime_uid']==1000 and len(captured['cases'])==1 and captured['neural_calls']>0,'Actual full-model case failed;retain raw report'
 case=captured['cases'][0];assert case['terminal'] and not case['neural_cpu_fallback'] and case['all_models_released']
 r.update(actual_complete_architecture_case_executed=True,case_report_sha256=hashlib.sha256((a.case_out/'status.json').read_bytes()).hexdigest(),
  neural_calls=captured['neural_calls'],case_wall_seconds=case['wall_seconds'],box_agreement_diagnostic=captured['aggregate'])
except BaseException:r.update(status='failed',error=traceback.format_exc())
finally:
 kill_owned()
 if r['production_pause_started'] and was_active:
  try:
   start=subprocess.run(['systemctl','start','ainvr-ai'],capture_output=True,text=True,timeout=45);r['finally_start_exit_code']=start.returncode
   deadline=time.monotonic()+40;first=None
   while time.monotonic()<deadline:
    try:
     current=snapshot()
     if first is None:first=current
     fresh=current['latest_timestamp'] is not None and time.time()-current['latest_timestamp']<10
     if current['inference_count']>first['inference_count'] and current['consecutive_errors']==0 and fresh:
      r.update(production_restored=True,after_first=first,after=current);break
    except Exception:r['restore_probe_error']='API temporarily unavailable;no credentials recorded'
    time.sleep(.5)
   r['services_after']={name:unit(name) for name in ['ainvr-ai','ainvr-recorder','ainvr-ingest']}
   assert r['production_restored'] and all(v=='active' for v in r['services_after'].values())
  except BaseException:r.update(status='failed',restoration_error=traceback.format_exc())
  r['pause_seconds']=time.time()-r['pause_started']
 if r['status']!='failed':r['status']='completed'
 r['finished']=time.time();persist()
print(json.dumps({k:r.get(k) for k in ['status','preflight_passed','production_pause_started','production_restored','actual_complete_architecture_case_executed','pause_seconds','error','restoration_error']}))
assert r['status']=='completed'
