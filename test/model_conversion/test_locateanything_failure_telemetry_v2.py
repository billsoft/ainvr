"""Control-only failure telemetry tests. No BPU calls or model execution."""
from pathlib import Path
import ast,hashlib,importlib.util,json,tempfile,time,types
import numpy as np
ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion'
old=CODE/'validate_locateanything_complete_fresh_bpu_v3.py';new=CODE/'validate_locateanything_complete_fresh_bpu_v5.py';wrapper=CODE/'run_locateanything_complete_fresh_case_v4.py'
assert hashlib.sha256(old.read_bytes()).hexdigest()=='a8cc3676cff5db5f88653dc5ecf8347bb664a01696992b53eb65b07c523a4082'
spec=importlib.util.spec_from_file_location('failure_telemetry_controls',new);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
checks=[]
def check(name,value):assert value,name;checks.append(name)
a=ast.parse(old.read_text());b=ast.parse(new.read_text())
for name in ['digest','parse_response','iou','maximum_matches','summarize']:
 x=next(n for n in a.body if isinstance(n,ast.FunctionDef) and n.name==name);y=next(n for n in b.body if isinstance(n,ast.FunctionDef) and n.name==name);check(name+' unchanged',ast.dump(x)==ast.dump(y))
def neural_calls(tree):return [ast.dump(n) for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr in ['generate','run_ordered','forward','close','embed','project']]
check('neural calls and arguments unchanged',neural_calls(a)==neural_calls(b))
assignments={n.targets[0].id:n.value.value for n in ast.parse(wrapper.read_text()).body if isinstance(n,ast.Assign) and isinstance(n.targets[0],ast.Name) and isinstance(n.value,ast.Constant)}
check('wrapper pins v5 source hash',assignments['VALIDATOR_SHA']==hashlib.sha256(new.read_bytes()).hexdigest())
compile(new.read_text(),str(new),'exec');compile(wrapper.read_text(),str(wrapper),'exec');check('new sources compile',True)
with tempfile.TemporaryDirectory(prefix='locate-failure-control-',dir=ROOT/'test/results') as temp:
 out=Path(temp);early=module.capture_failed_generation(ValueError('preflight control'),None,out)
 check('preflight failure claims no calls',early['actual_neural_calls']==0 and early['diagnostic_only'] and not early['terminal_output'])
 namespace={'time':time}
 source="def generate(state):\n traces=[{'accepted_tokens':[30,40],'pattern':'continue_ar'}]\n started=time.perf_counter()\n raise TimeoutError('control-only timeout')\n"
 exec(compile(source,str(CODE/'locateanything_bpu_generation_v1.py'),'exec'),namespace)
 executor=types.SimpleNamespace(loaded={},stats={'calls':25,'loads':20,'events':[{'action':'run','key':'control-only'}]})
 from locateanything_generation_control_v1 import GenerationState
 state=GenerationState(np.array([10,20]),{},mode='slow')
 state.prepare();state.accept(np.array([30]),'continue_ar')
 state.prepare();state.accept(np.array([40]),'continue_ar')
 check('actual GenerationState history is a list',isinstance(state.history,list))
 legacy_spec=importlib.util.spec_from_file_location('legacy_failure_telemetry',CODE/'validate_locateanything_complete_fresh_bpu_v4.py');legacy=importlib.util.module_from_spec(legacy_spec);legacy_spec.loader.exec_module(legacy)
 try:
  try:namespace['generate'](state)
  except TimeoutError as error:legacy.capture_failed_generation(error,executor,out)
 except AttributeError as error:check('legacy v4 actual-list defect reproduced','tolist' in str(error))
 else:raise AssertionError('Legacy list defect must be reproduced')
 try:namespace['generate'](state)
 except TimeoutError as error:partial=module.capture_failed_generation(error,executor,out)
 check('partial accepted tokens retained',partial['partial_generated_ids']==[30,40] and partial['step_count']==1)
 check('failed calls preserved separately',partial['actual_neural_calls']==25 and partial['all_models_released'])
 events=out/partial['events_file'];check('event hash verified',hashlib.sha256(events.read_bytes()).hexdigest()==partial['events_sha256'])
 check('partial output cannot claim terminal',partial['diagnostic_only'] and partial['terminal_output'] is False)
 json.dumps(partial,allow_nan=False);check('telemetry JSON finite',True)
report={'status':'passed','scope':'control-only failure telemetry; fake executor counters are not BPU evidence','actual_bpu_calls':0,'checks':checks,'source_sha256':hashlib.sha256(new.read_bytes()).hexdigest(),'wrapper_sha256':hashlib.sha256(wrapper.read_bytes()).hexdigest(),'frozen_validator_unchanged':True}
p=ROOT/'test/results/locateanything-failure-telemetry-controls-v2.json';assert not p.exists();p.write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))