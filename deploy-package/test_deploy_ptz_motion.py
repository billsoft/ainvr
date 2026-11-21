"""Isolated release tests: no production configuration, services or databases."""
import importlib.util,io,json,shutil,tarfile,tempfile,unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch
import deploy_ptz_motion as release
import release_common as common

class MotionReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.candidate=self.root/'out/candidate';self.candidate.mkdir(parents=True)
        self.patches=[patch.object(common,'ROOT',self.root),patch.object(release,'ROOT',self.root)]
        for p in self.patches:p.start()
        self.sources={}
        for name in ['deploy_ptz_motion.py','ptz-motion-state.mjs','test_deploy_ptz_motion.py']:
            self.put('deploy-package/'+name,'test source',source=True)
        self.put('backend/server.js','server')
        self.put('frontend/index.html','index')
        self.put('backend/ptz-compatibility.json',json.dumps({'motionAdmissionVersion':1}))
        self.put('shared/test','shared')
        for name in ['main.mjs','motion-admission.mjs','ingestion.mjs','observation-pump.mjs']:
            self.put('alarm-src/'+name,'alarm')
            source='alarm-service/src/'+name;p=self.root/source;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('alarm');self.sources[source]=common.sha(p)
        for name in ['package.json','package-lock.json']:
            p=self.root/'alarm-service'/name;p.write_text('{}');self.sources['alarm-service/'+name]=common.sha(p)
        (self.candidate/'status.json').write_text(json.dumps({'phase':'built','motionAdmissionVersion':1}))
        self.manifests()
    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.temp.cleanup()
    def put(self,name,value,source=False):
        p=self.candidate/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(value)
        if source:
            q=self.root/name;q.parent.mkdir(parents=True,exist_ok=True);q.write_text(value);self.sources[name]=common.sha(q)
    def manifests(self):
        (self.candidate/'source-manifest.json').write_text(json.dumps(self.sources))
        (self.candidate/'artifacts.json').write_text(json.dumps({n:common.files(self.candidate/n) for n in ['backend','frontend','alarm-src','deploy-package','shared']}))
    def test_complete_candidate(self):self.assertEqual(release.validate(self.candidate),self.candidate)
    def test_old_marker_rejected(self):
        self.put('backend/ptz-compatibility.json',json.dumps({'sceneBindingVersion':1}));self.manifests()
        with self.assertRaisesRegex(ValueError,'protocol'):release.validate(self.candidate)
    def test_source_changes_rejected(self):
        (self.root/'alarm-service/src/main.mjs').write_text('later generation')
        with self.assertRaisesRegex(ValueError,'generation changed'):release.validate(self.candidate)
    def test_mixed_alarm_even_rehashed_rejected(self):
        self.put('alarm-src/main.mjs','different build');self.manifests()
        with self.assertRaisesRegex(ValueError,'Mixed alarm'):release.validate(self.candidate)
    def test_missing_helper_rejected(self):
        del self.sources['deploy-package/ptz-motion-state.mjs'];self.manifests()
        with self.assertRaisesRegex(ValueError,'Publisher missing'):release.validate(self.candidate)
    def test_pending_legacy_is_not_dropped(self):
        with self.assertRaisesRegex(RuntimeError,'original-engine recovery'):release.require_no_legacy({'legacyPending':1})
        with self.assertRaises(RuntimeError):release.require_no_legacy({})
        release.require_no_legacy({'legacyPending':0,'authorizedPending':4})
    def test_second_pending_check_precedes_backend_stop_and_swaps(self):
        commands=[]
        before={'alarm':{'pid':12},'backendPid':13,'state':{'configurationDigest':'same'}}
        def pid(unit):return 0 if commands else (12 if unit=='ainvr-alarm' else 13)
        with patch.object(release,'validate'),patch.object(release,'pid',side_effect=pid),patch.object(release,'run',side_effect=lambda x:commands.append(x)),patch.object(release,'probe',return_value={'legacyPending':1}),patch.object(release.previous,'swap_tree') as swap:
            with self.assertRaisesRegex(RuntimeError,'Legacy pending'):release.paired_switch(self.candidate,self.root/'release',{'before':before})
            self.assertEqual(commands,[['systemctl','stop','ainvr-alarm']]);swap.assert_not_called()
    def test_changed_source_never_stops_services(self):
        with patch.object(release,'pid',side_effect=[12,13]),patch.object(release,'validate',side_effect=ValueError('changed')),patch.object(release,'run') as command:
            with self.assertRaises(ValueError):release.paired_switch(self.candidate,self.root/'release',{'before':{'alarm':{'pid':12},'backendPid':13}})
            command.assert_not_called()
    def test_default_cli_only_preflight(self):
        with patch('sys.argv',['deploy_ptz_motion.py','--candidate',str(self.candidate)]),patch.object(release,'preflight',return_value={'mode':'readonly'}) as check,patch.object(release,'deploy') as execute,patch('builtins.print'):
            release.main();check.assert_called_once();execute.assert_not_called()
    def test_legacy_backup_uses_git_archive_not_dirty_sources(self):
        data=io.BytesIO()
        with tarfile.open(fileobj=data,mode='w') as archive:
            item=tarfile.TarInfo('alarm-service/src/main.mjs');body=b'original running revision';item.size=len(body);archive.addfile(item,io.BytesIO(body))
        target=self.root/'backup';target.mkdir()
        with patch.object(release.subprocess,'run',return_value=SimpleNamespace(stdout=data.getvalue())) as command:
            release.backup_alarm({'legacy':'d'*40,'source':str(self.root/'alarm-service/src')},target)
            self.assertIn('archive',command.call_args.args[0]);self.assertIn('d'*40,command.call_args.args[0])
            self.assertEqual((target/'src/main.mjs').read_text(),'original running revision')
    def test_success_orders_pair_and_requires_protocol_ack(self):
        commands=[];fronts=[self.root/'front1',self.root/'front2'];dest=self.root/'release';dest.mkdir()
        before={'alarm':{'pid':12},'backendPid':13,'state':{'configurationDigest':'same'},'configuration':{},'watched':{}}
        probes=[{'legacyPending':0,'configurationDigest':'same'},{'protocolReady':True}]
        with patch.object(release,'validate'),patch.object(release,'pid',side_effect=[12,13,0,0]),patch.object(release,'run',side_effect=lambda x:commands.append(x)),patch.object(release,'probe',side_effect=probes),patch.object(release,'fingerprints',return_value={}),patch.object(release,'identities',return_value={}),patch.object(release.previous,'swap_tree') as swap,patch.object(release,'FRONTS',fronts),patch.object(release,'DROPIN',self.root/'95.conf'),patch.object(common,'ready'),patch.object(release,'alarm_source',return_value={'source':str(dest/'alarm/src')}):
            result=release.paired_switch(self.candidate,dest,{'before':before})
            self.assertTrue(result['protocolReady']);swap.assert_called_once()
        self.assertEqual(commands,[['systemctl','stop','ainvr-alarm'],['systemctl','stop','ainvr-backend'],['systemctl','daemon-reload'],['systemctl','start','ainvr-backend'],['systemctl','start','ainvr-alarm']])
        self.assertTrue(all(p.is_symlink() for p in fronts))
    def deployment_fixture(self):
        backups=self.root/'backups';backups.mkdir();releases=self.root/'releases';releases.mkdir()
        backend=self.root/'live-backend';shutil.copytree(self.candidate/'backend',backend)
        front=self.root/'live-front';shutil.copytree(self.candidate/'frontend',front)
        before={'candidate':str(self.candidate),'alarm':{'source':str(self.candidate/'alarm-src'),'legacy':None},'configuration':{},'watched':{}}
        mocks=[patch.object(release,'require_ssd'),patch.object(release,'preflight',return_value=before),patch.object(release,'BACKUPS',backups),patch.object(release,'RELEASES',releases),patch.object(release,'BACKEND',backend),patch.object(release,'FRONTS',[front]),patch.object(release,'DROPIN',self.root/'absent-dropin'),patch.object(release,'fingerprints',return_value={}),patch.object(release,'identities',return_value={})]
        for p in mocks:p.start();self.addCleanup(p.stop)
        return backups
    def test_retention_error_keeps_accepted_release_running_and_logs_class(self):
        backups=self.deployment_fixture()
        with patch.object(release,'paired_switch',return_value={'protocolReady':True}),patch.object(release.previous,'prune',side_effect=RuntimeError('Unrecognized legacy backup; manual reconciliation required')),patch.object(release,'run') as command:
            result=release.deploy(self.candidate,None)
            self.assertEqual(result['phase'],'applied');command.assert_not_called()
        record=json.loads(Path(result['transaction']).read_text())
        self.assertEqual(record['phase'],'applied');self.assertEqual(record['stage'],'complete')
        self.assertEqual(len(record['cleanupWarnings']),3)
        self.assertEqual(record['cleanupWarnings'][0],{'service':'backend','stage':'retention','type':'RuntimeError','message':'Unrecognized legacy backup; manual reconciliation required'})
        for marker in backups.glob('*/*/backup.json'):self.assertEqual(json.loads(marker.read_text())['phase'],'applied')
    def test_real_switch_failure_retains_stage_type_and_stops_alarm(self):
        backups=self.deployment_fixture()
        def broken(candidate,destination,record):
            record['stage']='protocol-readiness';raise ValueError('scope ACK missing')
        with patch.object(release,'paired_switch',side_effect=broken),patch.object(release,'run') as command:
            with self.assertRaisesRegex(RuntimeError,'protocol-readiness.*ValueError'):release.deploy(self.candidate,None)
            command.assert_called_once_with(['systemctl','stop','ainvr-alarm'])
        record=json.loads(next(backups.glob('backend/*/deployment.json')).read_text())
        self.assertEqual(record['phase'],'failed');self.assertEqual(record['error'],{'stage':'protocol-readiness','type':'ValueError','message':'scope ACK missing'})

if __name__=='__main__':unittest.main()
