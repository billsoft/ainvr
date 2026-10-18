"""Independent read-only steady production observation after prefill trial install."""
from pathlib import Path
import hashlib,json,subprocess,time,urllib.request
ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion';T=ROOT/'test/results';OUT=T/'locateanything-prefill-steady-postinstall-v139.json'
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def read(p):return json.loads(Path(p).read_text())
def main():
 assert not OUT.exists();install=read(T/'locateanything-prefill-runtime-upgrade-v138.json');assert install['status']=='installed_prefill_trial_and_current_native_results_real_SEI_verified' and install['finished']
 key=read(ROOT/'data/ai/config_overlay.json')['server']['api_key']
 def get(url,auth=False):
  with urllib.request.urlopen(urllib.request.Request(url,headers={'X-Api-Key':key} if auth else {}),timeout=5) as f:return json.load(f)
 def state():return get('http://127.0.0.1:8000/api/v1/channels/2baec0a3-9941-47dc-b1bd-d3d284488097',True)
 def media():
  h=get('http://127.0.0.1:8100/v1/recorder/health');s={x['name']:{k:x[k] for k in ['frames','recv_bytes','publish']} for x in get('http://127.0.0.1:1985/api/v1/streams')['streams'] if x['app']=='live' and x['name'] in ['xm','ai-n2q08c']};assert h['ok'] and h['storageHealthy'] and h['writeDegradedChannels']==0 and set(s)=={'xm','ai-n2q08c'} and all(x['publish']['active'] for x in s.values());return dict(recorder={k:h[k] for k in ['ok','storageHealthy','droppedMsLastHour','writeDegradedChannels']},streams=s)
 before=state();m=media();pin=sha(ROOT/'data/ai/config_overlay.json');assert pin==install['config_sha256'];services=['ainvr-ai','ainvr-locateanything-official-bpu','ainvr-recorder','ainvr-ingest'];pids={n:int(subprocess.check_output(['systemctl','show',n,'--property=MainPID','--value'],text=True)) for n in services};start=time.monotonic();samples=0
 while time.monotonic()-start<45:
  current=state();media();assert current['state']=='running' and current['stats']['consecutive_errors']==0 and current['config']==before['config'] and sha(ROOT/'data/ai/config_overlay.json')==pin;assert all(int(subprocess.check_output(['systemctl','show',n,'--property=MainPID','--value'],text=True))==v for n,v in pids.items());samples+=1;time.sleep(1)
 after=state();latest=media();a=after['stats'];b=before['stats'];pub=a['publish'];prior=b['publish'];assert a['inference_count']>=b['inference_count']+4 and pub['sei_injected']>=prior['sei_injected']+4 and pub['au_pushed']>prior['au_pushed'] and a['archive_backpressure_skip_count']==b['archive_backpressure_skip_count']
 assert pub['buffer']['generation_reset_events']==prior['buffer']['generation_reset_events'] and pub['buffer']['drop_events']==prior['buffer']['drop_events'] and pub['reconnect_count']==prior['reconnect_count'];assert latest['recorder']['droppedMsLastHour']==m['recorder']['droppedMsLastHour'] and all(latest['streams'][n]['frames']>m['streams'][n]['frames'] for n in m['streams'])
 helper=CODE/'read_locateanything_prefill_runtime_health_v138.py';assert sha(helper)=='b3a9a198f4fde4a22d753c904dd021ed9eaabb8fbc41b77490c67296df108938';health=json.loads(subprocess.check_output(['runuser','-u','sunrise','--','python3',str(helper)],text=True,timeout=10));assert health['persistent_worker']['cached_models']==46 and health['persistent_worker']['failed_requests']==0
 r=dict(status='steady_prefill_runtime_current_user_channel_and_SEI_verified',created=time.time(),source_sha256=sha(__file__),install_sha256=sha(T/'locateanything-prefill-runtime-upgrade-v138.json'),duration_seconds=time.monotonic()-start,samples=samples,service_pids=pids,before=before,after=after,media_before=m,media_after=latest,health=health,new_inferences=a['inference_count']-b['inference_count'],new_sei=pub['sei_injected']-prior['sei_injected'],overload_delta=a['overload_drop_count']-b['overload_drop_count'],archive_backpressure_delta=a['archive_backpressure_skip_count']-b['archive_backpressure_skip_count'],config_sha256=pin,user_configuration_unchanged=True,source_recording_stopped=False,speed_scope='Different live images and rolling p95 are observational,not controlled causal speed evidence')
 OUT.write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({k:r[k] for k in ['status','new_inferences','new_sei','overload_delta','archive_backpressure_delta']}))
if __name__=='__main__':main()
