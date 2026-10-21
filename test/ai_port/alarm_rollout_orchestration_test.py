"""Deployment orchestration tests: no real services, DB, or production paths."""
import importlib.util,json,pathlib,tempfile,unittest,types
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('rollout',ROOT/'deploy-package/update-alarm-console-s100p.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class RolloutTest(unittest.TestCase):
 def run_failure(self,recovery_fails):
  with tempfile.TemporaryDirectory(prefix='ainvr-rollout-test-') as tmp:
   base=pathlib.Path(tmp);root=base/'repo';ssd=base/'ssd';root.mkdir();ssd.mkdir()
   def put(p,text='x'):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)
   unit=root/'deploy/s100p/ainvr-alarm.service';old=root/'deploy/s100p/alarm-service/old';old.mkdir(parents=True)
   put(unit,'WorkingDirectory='+str(old)+'\n')
   put(root/'deploy/s100p/runtime/alarm-service-bootstrap.json',json.dumps({'service_token':'fixture'}))
   (root/'test/results').mkdir(parents=True)
   for f in ['alarm_offline_migration.mjs','alarm_migration_rollback.mjs']:put(root/'test/ai_port'/f)
   web=ssd/'web';web.mkdir();artifacts={}
   for name in ['backend','frontend']:
    live=root/'srs-web-console'/name/'dist';put(live/'assets/old.js')
    frozen=web/'source/srs-web-console'/name/'dist';put(frozen/'assets/new.js')
    artifacts[name]={'root':str(frozen),'sha256':m.tree(frozen)}
   put(web/'status.json',json.dumps({'phase':'passed','artifacts':artifacts}));put(web/'source-manifest.json','{}')
   alarm=ssd/'alarm';put(alarm/'release/src/app.mjs');put(root/'alarm-service/src/app.mjs')
   files={'src/app.mjs':m.sha(alarm/'release/src/app.mjs')}
   put(alarm/'source-manifest.json',json.dumps(files));put(alarm/'artifact-manifest.json',json.dumps(files))
   put(alarm/'status.json',json.dumps({'phase':'passed','counts':{'skipped':0},'artifact_manifest_sha256':m.sha(alarm/'artifact-manifest.json')}))
   calls=[];real_read=pathlib.Path.read_bytes;stats_failed=False
   def read(p):
    if str(p)=='/proc/123/environ':return b'CONFIG_PG_HOST=fixture\0CONFIG_PG_DATABASE=fixture\0'
    return real_read(p)
   def cmd(args):calls.append(tuple(args));return '123' if 'MainPID' in args else ''
   def get(url,headers=None):
    nonlocal stats_failed
    if 'service-states' in url:return {'data':{'status':'applied','appliedVersion':1,'desiredVersion':1}}
    if '/snapshot?' in url:return {'data':[{'config':{'port':22222,'api_token':'fixture'}}]}
    if 'behavior-statistics' in url and not stats_failed:stats_failed=True;raise RuntimeError('injected post-start failure')
    return {'status':'ready','storage':{'writable':True},'rule_configuration':{'state':'applied','revision':'2'},'config':{'applied_version':1}}
   def run(args,**kw):
    calls.append(tuple(args))
    if args[0]=='docker':kw['stdout'].write(b'backup'*100);return types.SimpleNamespace(returncode=0)
    mode=args[2]
    if mode=='prepare':pathlib.Path(args[-1]).write_text('{"guard":"fixture"}')
    return types.SimpleNamespace(returncode=1 if mode=='rollback' and recovery_fails else 0,stdout=b'{"migration_changed":true}')
   with patch.object(m,'ROOT',root),patch.object(m,'SSD',ssd),patch.object(m,'identity',return_value={'ActiveState':'active'}),patch.object(m,'cmd',side_effect=cmd),patch.object(m,'get',side_effect=get),patch.object(m.subprocess,'run',side_effect=run),patch.object(pathlib.Path,'is_mount',return_value=True),patch.object(pathlib.Path,'read_bytes',read),patch.object(m.os,'chown'),patch.object(m.os,'lchown'),patch('sys.argv',['rollout','--web-candidate',str(web),'--alarm-candidate',str(alarm)]):
    with self.assertRaises(RuntimeError):m.main()
   report=json.loads((root/'test/results/alarm-submit-deployment-20261019.json').read_text())
   prepare=next(i for i,c in enumerate(calls) if c[0]=='node' and c[2]=='prepare')
   rollback=next(i for i,c in enumerate(calls) if c[0]=='node' and c[2]=='rollback')
   self.assertIn(('systemctl','stop','ainvr-backend.service'),calls[:prepare]);self.assertIn(('systemctl','stop','ainvr-alarm.service'),calls[:prepare])
   self.assertIn(('systemctl','stop','ainvr-alarm.service'),calls[prepare:rollback])
   self.assertTrue((root/'srs-web-console/backend/dist/assets/old.js').exists())
   self.assertFalse(any('ainvr-ai.service' in c or 'ainvr-recorder.service' in c for c in calls))
   if recovery_fails:
    self.assertEqual(report['phase'],'manual-recovery-required');self.assertFalse(any(c[0]=='systemctl' and c[1] in ['start','restart'] for c in calls[rollback+1:]))
   else:
    self.assertEqual(report['phase'],'rolled-back');self.assertTrue(report['database_restored']);self.assertTrue(report['business_configuration_verified'])
    self.assertIn(('systemctl','start','ainvr-alarm.service'),calls[rollback+1:])
 def test_guarded_recovery_before_restarting_old_services(self):self.run_failure(False)
 def test_failed_recovery_keeps_publishers_stopped(self):self.run_failure(True)
if __name__=='__main__':unittest.main()
