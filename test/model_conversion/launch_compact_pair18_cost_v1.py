from pathlib import Path
import hashlib,json,os,subprocess,time,sys
r=Path('/work/official-llm-v1');sys.path.insert(0,str(r))
from locateanything_compile_memory_v1 import resource_snapshot,has_headroom
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
guard=r/'guard_locateanything_compact_affine_decoder_job_v6.py';builder=r/'official_build_compact_affine_decoder_group_v2_sdk448.py'
assert sha(guard)=='5e7e43587d157e8079e5b88a07d0cc0265dca22bed8f2fb5bc88bcf0e2208739' and sha(builder)=='dc65fb759764d89a9c026ae05a3171c0931888343cf1dca3124f9439e3f4067d'
controls=json.loads((r/'locateanything-compile-memory-controls-v1.json').read_text());assert controls['status']=='passed' and controls['tests_run']==8
name='compact-affine-g32-control-pair18-s1-cost-v1';target=Path('/opt/locate-oellm-research-v1/compact-affine-g32-control-decoder-group-18-19-s1-v2-sdk448');proof=r/'locateanything-compact-pair18-cost-launch-proof-v1.json';log=r/(name+'-launcher.log')
assert not target.exists() and not proof.exists() and not log.exists() and not (r/(name+'-guard.json')).exists()
main=json.loads((r/'compact-affine-g32-control-group1-s1-serial-v1-guard.json').read_text());proc=Path('/proc')/str(main['child_pid']);parts=(proc/'stat').read_text().rsplit(')',1)[1].split();assert parts[19]==main['child_start_ticks'] and str(builder).encode() in (proc/'cmdline').read_bytes().split(bytes([0]))
resource=resource_snapshot();assert has_headroom(resource,preparation=True),'Do not start the optional cost probe without headroom'
allowed=sorted(os.sched_getaffinity(0));cpu=allowed[0];os.nice(10);os.sched_setaffinity(0,{cpu})
command=['python3','-u',str(guard),'--name',name,'--layers','2','--start-layer','18','--seq','1','--label','g32-control','--jobs','1']
with log.open('xb') as stream:child=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True,env=dict(os.environ,CUDA_VISIBLE_DEVICES=''))
ticks=Path(f'/proc/{child.pid}/stat').read_text().rsplit(')',1)[1].split()[19];time.sleep(2)
p=Path('/proc')/str(child.pid);assert p.exists() and (p/'stat').read_text().rsplit(')',1)[1].split()[19]==ticks
state=json.loads((r/(name+'-guard.json')).read_text());assert state['guard_pid']==child.pid and state['source_sha256']==sha(guard)
d=dict(status='low_priority_two_layer_cost_guard_live',checked=time.time(),guard_pid=child.pid,guard_start_ticks=ticks,guard_source_sha256=sha(guard),builder_source_sha256=sha(builder),resource_before_launch=resource,guard_state=state,guard_cmdline=(p/'cmdline').read_text().replace(chr(0),' '),cpu_affinity=sorted(os.sched_getaffinity(child.pid)),niceness=os.getpriority(os.PRIO_PROCESS,child.pid),main_compiler_identity=dict(pid=main['child_pid'],start_ticks=main['child_start_ticks'],untouched=True),scope='Original layers18..19/same exact best group32W4 checkpoint;compile-cost qualification only;no replacement of the existing four-group workflow',maximum_compile_seconds=None,production_actions=False,neural_gpu_calls=0,whole_model_verified=False)
if state.get('child_pid'):
 c=Path('/proc')/str(state['child_pid']);d['compiler_identity']=dict(pid=state['child_pid'],start_ticks=state['child_start_ticks'],stat=(c/'stat').read_text(),cmdline=(c/'cmdline').read_text().replace(chr(0),' '),cpu_affinity=sorted(os.sched_getaffinity(state['child_pid'])),niceness=os.getpriority(os.PRIO_PROCESS,state['child_pid']))
 assert d['compiler_identity']['stat'].rsplit(')',1)[1].split()[19]==state['child_start_ticks']
proof.write_text(json.dumps(d,indent=2)+'\n');print(json.dumps({k:d.get(k) for k in ['status','guard_pid','guard_start_ticks','cpu_affinity','niceness','compiler_identity','main_compiler_identity']}))