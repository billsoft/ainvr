"""Private fake-filesystem/subprocess release tests. No live services or PG."""
import contextlib,hashlib,importlib.util,json,os,pwd,shutil,subprocess,sys,tempfile,unittest,io,types
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'deploy-package'))
import deploy_ptz_release as deploy
import release_common as common
import search_release_profile as search

class Fixture:
    def __init__(self,base):
        self.base=Path(base);self.root=self.base/'ainvr';self.root.mkdir()
        self.ssd=self.base/'ssd';self.ssd.mkdir();self.backups=self.ssd/'ainvr-rollback';self.backups.mkdir()
        self.units=self.base/'etc/systemd/system';self.units.mkdir(parents=True)
        self.policy=self.base/'etc/tmpfiles.d/ainvr-large-models.conf'
        self.candidate=self.root/'out/search-candidate';self.candidate.mkdir(parents=True)
        self.commands=[];self.states={};self.owner=pwd.getpwuid(os.getuid());self.stop_fail=None
        for service,unit in search.UNITS.items():
            path=self.units/(unit+'.service')
            if service!='search-service':path.write_text('[Service]\nExecStart=old\n')
            self.states[unit]={'exists':service!='search-service','active':service in ('backend','helper'),'enabled':'disabled',
              'executable':str(search.targets(self.root).get(service,self.root/'runtime-executable')),'pid':0}
        for service,path in search.targets(self.root).items():
            if service=='search-service':continue
            if service=='llm-service':
                path=self.root/'deploy/s100p/llm-service/old/ainvr_llm_service';self.states['ainvr-llm']['executable']=str(path)
            path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(('old '+service).encode());path.chmod(0o755)
        runtime=self.root/'deploy/s100p/runtime';runtime.mkdir(parents=True,exist_ok=True)
        for name in ['ai-service.env','ai-service.json','llm-service-bootstrap.json','llm-service-backend.env','backend.env','restart-helper.env']:
            (runtime/name).write_text('fixture-only-'+name);(runtime/name).chmod(0o600)
        self.put('src/frozen.txt',b'frozen')
        for folder in ['backend','frontend']:
            target=self.root/'srs-web-console'/folder/'dist';target.mkdir(parents=True);(target/'old').write_text(folder+' old')
            self.artifact(folder+'/server.js' if folder=='backend' else folder+'/index.html',b'new console')
        for name in ['restart_helper.py','observability.py']:self.artifact('helper/'+name,b'new helper')
        self.artifact('shared/python/shared.py',b'new shared helper')
        self.artifact('deploy-package/ainvr-large-models.tmpfiles.conf',b'd /run/ainvr 0700 sunrise sunrise -\n')
        for folder,file in search.BINARY_ARTIFACTS.values():self.artifact(folder+'/'+file,b'\x7fELF\x02\x01'+b'\0'*12+(183).to_bytes(2,'little')+b'new release')
        self.artifact('search-native/build-contract.json',json.dumps({'schema':1,'bpu_text':True,'tokenizer':True,'hardware_probes':False,'models_packaged':False}).encode())
        self.artifact('source-manifest.json',json.dumps({'src/frozen.txt':common.sha(self.root/'src/frozen.txt')}).encode())
        self.manifest()
        self.artifact('status.json',json.dumps({'phase':'built','releaseProfile':'search','searchComponents':True}).encode())
    def put(self,name,data):
        path=self.root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
    def artifact(self,name,data):
        path=self.candidate/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
    def manifest(self):
        names=['frontend','backend','helper','shared','deploy-package','search-ai','search-llm','search-native']
        self.artifact('artifacts.json',json.dumps({name:common.files(self.candidate/name) for name in names}).encode())
    def run(self,args,timeout=60):
        args=list(map(str,args));self.commands.append(args)
        if args[:2]==['systemctl','show']:
            unit=args[2];state=self.states.get(unit,{'exists':False,'active':False,'pid':0})
            if '--property=LoadState' in args:return 'loaded'if state['exists'] else'not-found'
            if '--property=MainPID,ActiveState' in args:return 'MainPID=0\nActiveState='+('active'if state['active']else'inactive')
            raise AssertionError('Unexpected show '+str(args))
        if args[:2]==['systemctl','stop']:
            if self.stop_fail==args[2]:self.stop_fail=None;raise subprocess.CalledProcessError(1,args)
            self.states[args[2]]['active']=False;return ''
        if args[:2]==['systemctl','start']:self.states[args[2]]['active']=True;return ''
        if args[:2]==['systemctl','enable']:
            self.states['ainvr-search'].update(exists=True,active=True,enabled='enabled');return ''
        if args[:2]==['systemctl','disable']:
            self.states['ainvr-search']['enabled']='disabled';return ''
        if args[:2] in [['systemctl','daemon-reload'],['systemd-analyze','verify'],['systemd-tmpfiles','--create']]:
            self.states['ainvr-search']['exists']=(self.units/'ainvr-search.service').exists();return ''
        raise AssertionError('Live or unrelated subprocess attempted: '+str(args))
    @contextlib.contextmanager
    def patched(self):
        original_states=json.loads(json.dumps(self.states))
        def ss(publisher,unit,optional=False):return json.loads(json.dumps(self.states[unit]))
        with contextlib.ExitStack()as stack:
            for obj,name,value in [(deploy,'ROOT',self.root),(deploy,'SSD',self.ssd),(deploy,'BACKUPS',self.backups),
              (common,'ROOT',self.root),(search,'UNIT_ROOT',self.units),(search,'TMPFILES',self.policy),
              (deploy,'run',self.run),(deploy,'require_ssd',lambda:None),(deploy,'backend_ready',lambda:None),
              (deploy,'ptz_preflight',lambda *a:None),(search,'parameter_state',lambda p:{'config_documents':{'old/system/settings':'unchanged'},'config_secrets':'unchanged'}),
              (search,'watched',lambda p:{'SRS':'same','other':'same'}),(search,'wait',lambda *a:None),(search,'service_state',ss),
              (search,'runtime_dependencies',lambda p:search.elf(p)),(search.pwd,'getpwnam',lambda name:self.owner)]:stack.enter_context(patch.object(obj,name,value))
            yield original_states

class SearchReleaseTests(unittest.TestCase):
    def test_llm_cold_start_budget_does_not_accept_loading(self):
        clock=[0.0];probes=[]
        publisher=types.SimpleNamespace(run=lambda args:'123')
        def response(*args,**kwargs):
            probes.append(clock[0]);ready=clock[0]>=90
            return io.BytesIO(json.dumps({'model':'ready'if ready else'loading','ready':ready,'config_version':10}).encode())
        with patch.object(search.time,'monotonic',lambda:clock[0]),patch.object(search.time,'sleep',lambda seconds:clock.__setitem__(0,clock[0]+seconds)),patch.object(search.urllib.request,'urlopen',response):
            search.wait(publisher,'llm-service',None)
        self.assertGreaterEqual(clock[0],90);self.assertLess(clock[0],180)
        self.assertGreater(len(probes),200)

    def test_llm_never_ready_still_fails_with_bounded_wait(self):
        clock=[0.0];publisher=types.SimpleNamespace(run=lambda args:'123')
        with patch.object(search.time,'monotonic',lambda:clock[0]),patch.object(search.time,'sleep',lambda seconds:clock.__setitem__(0,clock[0]+seconds)),patch.object(search.urllib.request,'urlopen',lambda *a,**k:io.BytesIO(b'{"model":"loading","ready":true,"config_version":10}')):
            with self.assertRaisesRegex(RuntimeError,'llm-service'):search.wait(publisher,'llm-service',None)
        self.assertEqual(clock[0],180)

    def test_read_only_check_has_no_service_calls_or_identity_creation(self):
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(tmp)
            with f.patched():report=search.plan(deploy,f.candidate)
            self.assertTrue(report['verified']);self.assertFalse(report['productionChanged']);self.assertFalse(report['modelsPackaged'])
            self.assertEqual(f.commands,[]);self.assertFalse((f.root/'deploy/s100p/runtime/search-service-bootstrap.json').exists())
            self.assertEqual(list(f.backups.iterdir()),[])

    def test_complete_apply_and_ssd_only_rollback_preserve_original_states(self):
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(tmp)
            with f.patched()as original:
                report=search.apply(deploy,f.candidate)
                self.assertTrue(report['configurationPreserved']);self.assertFalse(report['searchEnablementChanged'])
                bootstrap=f.root/'deploy/s100p/runtime/search-service-bootstrap.json';identity=json.loads(bootstrap.read_text())
                self.assertGreaterEqual(len(identity['service_token']),64);self.assertEqual(bootstrap.stat().st_mode&0o777,0o600)
                self.assertEqual(bootstrap.stat().st_uid,f.owner.pw_uid)
                old=Path(original['ainvr-llm']['executable']);old.unlink();old.parent.rmdir()
                result=search.rollback(deploy,Path(report['rollback']))
                self.assertTrue(result['rolledBack']);self.assertTrue(result['schemaRetained'])
                self.assertEqual(search.targets(f.root)['llm-service'].read_bytes(),b'old llm-service')
                self.assertFalse(bootstrap.exists());self.assertFalse(search.targets(f.root)['search-service'].exists())
                self.assertFalse((f.units/'ainvr-search.service').exists())
                for unit,old in original.items():self.assertEqual(f.states[unit]['active'],old['active'],unit)
                self.assertIn(str(search.targets(f.root)['llm-service']),(f.units/'ainvr-llm.service.d/96-search-release.conf').read_text())
                stopped=[cmd[2]for cmd in f.commands if cmd[:2]==['systemctl','stop']]
                self.assertEqual(stopped[0:4],['ainvr-ai','ainvr-backend','ainvr-llm','ainvr-restart-helper'])
                self.assertEqual(stopped[4:6],['ainvr-search','ainvr-ai'])
                for cmd in f.commands:
                    self.assertFalse(any(unit in cmd for unit in search.WATCHED));self.assertNotIn(identity['service_token'],str(cmd))
                self.assertEqual((f.root/'deploy/s100p/runtime/backend.env').read_text(),'fixture-only-backend.env')
                for service in search.SERVICES:self.assertLessEqual(len(list((f.backups/service).iterdir())),3)

    def test_mid_stop_failure_rolls_back_already_stopped_services(self):
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(tmp);f.stop_fail='ainvr-llm'
            with f.patched()as original:
                with self.assertRaises(subprocess.CalledProcessError):search.apply(deploy,f.candidate)
                for unit,old in original.items():self.assertEqual(f.states[unit]['active'],old['active'],unit)
                self.assertEqual((f.root/'srs-web-console/backend/dist/old').read_text(),'backend old')
                state=json.loads(next((f.backups/'backend').glob('*/deployment.json')).read_text())
                self.assertEqual(state['phase'],'rolled_back')

    def test_rollback_refuses_customer_config_edits(self):
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(tmp)
            with f.patched():
                report=search.apply(deploy,f.candidate);f.commands.clear()
                (f.root/'deploy/s100p/runtime/backend.env').write_text('new customer edit')
                with self.assertRaisesRegex(ValueError,'Concurrent managed'):search.rollback(deploy,Path(report['rollback']))
                self.assertEqual(f.commands,[])

    def test_existing_identity_is_preserved_and_malformed_identity_rejected(self):
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(tmp)
            with f.patched():
                writes=search.identity_files(f.root,f.owner)
                for path,data in writes.items():common.atomic_bytes(path,data,0o600,(f.owner.pw_uid,f.owner.pw_gid))
                self.assertEqual(search.identity_files(f.root,f.owner),{})
                bootstrap=f.root/'deploy/s100p/runtime/search-service-bootstrap.json';bootstrap.chmod(0o644)
                with self.assertRaisesRegex(ValueError,'private'):search.identity_files(f.root,f.owner)

    def test_unknown_stop_custody_prevents_binary_replacement(self):
        class Publisher:
            def run(self,args):return 'MainPID=52\nActiveState=active'if args[1]=='show'else''
        with self.assertRaisesRegex(RuntimeError,'ownership'):search.stop(Publisher(),'ainvr-ai')

    def test_model_artifact_cannot_be_smuggled_into_release(self):
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(tmp);f.artifact('search-native/model.hbm',b'not packaged');f.manifest()
            with f.patched():
                with self.assertRaisesRegex(ValueError,'must not be packaged'):search.validate(deploy,f.candidate)

    def test_runtime_symlink_cannot_turn_system_disk_install_into_ssd_dependency(self):
        with tempfile.TemporaryDirectory()as tmp:
            root=Path(tmp)/'root';root.mkdir();outside=Path(tmp)/'other';outside.mkdir()
            (root/'runtime').symlink_to(outside,target_is_directory=True)
            with self.assertRaisesRegex(ValueError,'symlink'):search.system_disk_paths(root,[root/'runtime/secret.env'])

    def test_missing_bpu_or_unrelated_artifacts_fail_check(self):
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(tmp)
            with f.patched():
                contract=f.candidate/'search-native/build-contract.json';value=json.loads(contract.read_text());value['bpu_text']=False;contract.write_text(json.dumps(value));f.manifest()
                with self.assertRaisesRegex(ValueError,'BPU text'):search.validate(deploy,f.candidate)
                value['bpu_text']=True;contract.write_text(json.dumps(value));f.manifest()
                manifest=json.loads((f.candidate/'artifacts.json').read_text());manifest['onvif']={};(f.candidate/'artifacts.json').write_text(json.dumps(manifest))
                with self.assertRaisesRegex(ValueError,'unrelated'):search.validate(deploy,f.candidate)

    def test_runtime_dependency_metadata_rejects_ssd_without_executing_binary(self):
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(tmp);binary=f.candidate/'search-native/ainvr_search_service'
            with patch.object(search.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'(RUNPATH) Library runpath: [/mnt/ainvr-ssd/build/lib]',''))as run:
                with self.assertRaisesRegex(ValueError,'SSD'):search.runtime_dependencies(binary)
                self.assertEqual(run.call_args.args[0],['readelf','--dynamic',str(binary)])

    def test_parameter_preservation_only_allows_additive_disabled_search_document(self):
        before={'config_documents':{'old/system/settings':'h'},'config_secrets':'same'}
        self.assertFalse(search.parameters_unchanged(before,{'config_documents':{**before['config_documents'],'search-service/system/settings':'new'},'config_secrets':'same'}))
        self.assertFalse(search.parameters_unchanged(before,{'config_documents':{'old/system/settings':'changed'},'config_secrets':'same'}))
        self.assertFalse(search.parameters_unchanged(before,{'config_documents':before['config_documents'],'config_secrets':'changed'}))

    def test_exact_020_seed_transition_requires_prequalification_and_published_audit_proof(self):
        old='a'*64;new='b'*64;migration='c'*64;key='search-service/system/settings'
        pre={'migration_sha256':migration,'eligible':{'document_id':'22','desired_version':7,'document_hash':old,'expected_after_hash':new},'completed':None}
        post={'migration_sha256':migration,'eligible':None,'completed':{'document_id':'22','version_before':7,'version_after':9,'document_hash':new}}
        before={'config_documents':{key:old,'unrelated/system/settings':'unchanged'},'config_secrets':'same','search_seed_020':pre}
        after={'config_documents':{key:new,'unrelated/system/settings':'unchanged'},'config_secrets':'same','search_seed_020':post}
        self.assertTrue(search.parameters_unchanged(before,after))
        for field,value in [('document_id','23'),('version_before',6),('document_hash','d'*64)]:
            broken=json.loads(json.dumps(after));broken['search_seed_020']['completed'][field]=value
            self.assertFalse(search.parameters_unchanged(before,broken),field)
        broken=json.loads(json.dumps(before));broken['search_seed_020']['eligible']=None
        self.assertFalse(search.parameters_unchanged(broken,after))
        broken=json.loads(json.dumps(after));broken['config_secrets']='changed'
        self.assertFalse(search.parameters_unchanged(before,broken))
        broken=json.loads(json.dumps(after));broken['config_documents']['unrelated/system/settings']='changed'
        self.assertFalse(search.parameters_unchanged(before,broken))

    def test_new_seed_requires_exact_018_or_020_sql_proof(self):
        key='search-service/system/settings';digest='a'*64
        before={'config_documents':{},'config_secrets':'same','search_seed_020':{'migration_sha256':'c'*64,'eligible':None,'completed':None}}
        after={'config_documents':{key:digest},'config_secrets':'same','search_seed_020':{'migration_sha256':'c'*64,'eligible':{'document_hash':digest},'completed':None}}
        self.assertTrue(search.parameters_unchanged(before,after))
        after['search_seed_020']['eligible']=None
        self.assertFalse(search.parameters_unchanged(before,after))

    def test_search_unit_restart_and_non_ssd_runtime_are_bounded(self):
        text=search.unit_text(Path('/home/sunrise/ainvr'))
        self.assertIn('StartLimitBurst=2',text);self.assertIn('RestartSec=15',text);self.assertIn('User=sunrise',text)
        self.assertNotIn('/mnt/',text);self.assertNotIn('RuntimeDirectory=',text)

    def test_builder_only_builds_selected_hardware_targets(self):
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(tmp)
            for folder,_ in search.BINARY_ARTIFACTS.values():shutil.rmtree(f.candidate/folder)
            commands=[];builds={key:f.root/'out/build'/key for key in search.BINARY_ARTIFACTS}
            def run(args,cwd,label,timeout):
                commands.append(args)
                if args[0:2]==['cmake','-S']:
                    target=Path(args[args.index('-B')+1]);target.mkdir(parents=True,exist_ok=True)
                    flags=[a[2:].replace('=ON',':BOOL=ON').replace('=OFF',':BOOL=OFF')for a in args if a.startswith('-DAINVR_')]
                    (target/'CMakeCache.txt').write_text('\n'.join(flags))
                else:
                    target=Path(args[2]);file=args[args.index('--target')+1]
                    (target/file).write_bytes(b'\x7fELF\x02\x01'+b'\0'*12+(183).to_bytes(2,'little'))
            with patch.object(search,'runtime_dependencies',side_effect=search.elf):search.prepare_components(f.root,f.candidate,run,builds)
            self.assertEqual(len(commands),6);self.assertTrue(all(c[0]=='cmake'for c in commands))
            self.assertTrue(any('-DAINVR_SEARCH_WITH_BPU_TEXT=ON'in c for c in commands))
            self.assertTrue(any('-DAINVR_SEARCH_BUILD_HARDWARE_PROBES=OFF'in c for c in commands))
            self.assertFalse(any('ctest'in c or any(str(a).endswith('.hbm')for a in c)for c in commands))

    def test_common_snapshot_restores_symlink_target_from_backup(self):
        with tempfile.TemporaryDirectory()as tmp:
            root=Path(tmp);target=root/'old-unit';target.write_text('old unit');link=root/'unit';link.symlink_to(target)
            backup=root/'backup';records=common.snapshot_files([link],backup,root);link.unlink();target.unlink()
            common.restore_files(records,backup,[link],root)
            self.assertTrue(link.is_symlink());self.assertEqual(link.read_text(),'old unit')

    def test_old_cli_defaults_and_format_stay_compatible(self):
        with patch.object(sys,'argv',['deploy_ptz_release.py','--check','old-candidate']),patch.object(deploy,'validate',return_value=Path('old-candidate'))as check,patch('builtins.print'):
            deploy.main();check.assert_called_once_with(Path('old-candidate'))
        self.assertEqual(deploy.SERVICES,['ai-service','onvif','gb28181','alarm-service','backend','web'])

if __name__=='__main__':unittest.main()
