"""AINVR installer fault tests: real private files, mocked host services only.

These do not prove a fresh board installation. Run from the remote repository:
python3 -m unittest discover -s test/ai_port -p test_ai_install_transaction.py
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import signal
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('ainvr_ai_install',ROOT/'deploy-package/install-ai-s100p.py')
installer=importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def elf(payload):
    header=bytearray(64);header[:6]=b'\x7fELF\x02\x01';header[18:20]=(183).to_bytes(2,'little')
    return bytes(header)+payload


class InstallTransactionTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='ainvr-ai-install-test-')
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.unit=self.root/'deploy/s100p/ainvr-ai.service';self.unit.parent.mkdir(parents=True)
        self.previous=self.root/'previous-service';self.previous.write_bytes(elf(b'previous-running-image'))
        self.target=self.root/'deploy/s100p/bin/ainvr_ai_service';self.target.parent.mkdir()
        self.old=elf(b'old-target');self.target.write_bytes(self.old)
        self.source=self.root/'candidate';self.new=elf(b'new-candidate');self.source.write_bytes(self.new)
        self.oldunit=('ExecStart='+str(self.previous)+' config.json overlay.json models runtime.env\n').encode()
        self.unit.write_bytes(self.oldunit)
        self.system=self.root/'etc/ainvr-ai.service';self.system.parent.mkdir();self.system.symlink_to(self.unit)
        self.ssd=self.root/'ssd';self.ssd.mkdir()
        self.protected={}
        for rel in ['deploy/s100p/runtime/ai-service.json','deploy/s100p/runtime/ai-service.env','data/ai/config_overlay.json']:
            p=self.root/rel;p.parent.mkdir(parents=True,exist_ok=True)
            p.write_text('private-test-only '+rel);self.protected[p]=p.read_bytes()
        self.info={'version':'ainvr-s100p-reused-control-0.7','ffmpeg':{
            'version':'8.1.2','avformat_version':(62<<16)|(12<<8)|102,
            'avcodec_version':(62<<16)|(28<<8)|102,'avutil_version':(60<<16)|(26<<8)|102}}
        self.health={'version':self.info['version'],'media':{'ffmpeg':self.info['ffmpeg']},
            'status':'ok','business':{'ready':True},'capabilities':{'model_providers':['bpu']}}
        self.commands=[];self.boot='disabled';self.active=False
        self.failure=None;self.failed_once=False;self.match=True;self.conflict=False
        self.real_atomic=installer.atomic

    def fake_subprocess(self,args,**kwargs):
        if args==[str(self.source),'--runtime-info']:
            return subprocess.CompletedProcess(args,0,json.dumps(self.info),'')
        if args[:2]==['systemctl','is-enabled']:
            return subprocess.CompletedProcess(args,0 if self.boot=='enabled' else 1,self.boot+'\n','')
        if args[:2]==['systemctl','is-active']:
            return subprocess.CompletedProcess(args,0 if self.active else 3,'active\n' if self.active else 'inactive\n','')
        self.fail('Unexpected real subprocess boundary: '+repr(args))

    def fake_run(self,*args):
        self.commands.append(args)
        if args[0]=='ldd':return 'libdnn.so => /usr/hobot/lib/libdnn.so\n'
        assert args[0]=='systemctl'
        action=args[1]
        if action=='enable':self.boot='enabled'
        if action=='disable':
            self.boot='disabled'
            # Linux can remove an external unit's primary symlink on disable.
            if self.system.is_symlink():self.system.unlink()
        if action=='restart':self.active=True
        if action=='stop':self.active=False
        if action==self.failure and not self.failed_once:
            self.failed_once=True;raise RuntimeError('injected '+action+' failure')
        if action=='show':return '98765\n'
        return ''

    def fake_atomic(self,path,data,mode):
        fail=(not self.failed_once and (
            (self.failure=='unit-before-rename' and path==self.unit and data!=self.oldunit) or
            (self.failure=='unit-fsync' and path==self.unit and data!=self.oldunit) or
            (self.failure=='binary-fsync' and path==self.target and data==self.new) or
            (self.failure in ('keyboard-interrupt','sigterm') and path==self.unit and data!=self.oldunit)))
        if fail and self.failure=='unit-before-rename':
            self.failed_once=True;raise OSError('injected unit rename failure')
        self.real_atomic(path,data,mode)
        if fail:
            self.failed_once=True
            if self.failure=='keyboard-interrupt':raise KeyboardInterrupt()
            if self.failure=='sigterm':os.kill(os.getpid(),signal.SIGTERM)
            raise OSError('injected directory fsync failure')

    def urlopen(self,*args,**kwargs):
        if self.conflict:
            # Change a user file after its identity was captured, before swap.
            p=next(iter(self.protected));p.write_bytes(b'concurrent-user-config')
        return io.StringIO(json.dumps(self.health))

    def execute(self,start=True):
        argv=['install-ai-s100p.py','--binary',str(self.source)]+(['--start'] if start else [])
        with patch.multiple(installer,ROOT=self.root,SYSTEM_UNIT=self.system,SSD_ROOT=self.ssd,HEALTH_WAIT_SECONDS=0), \
                patch.object(installer.os,'geteuid',return_value=0), \
                patch.object(Path,'is_mount',return_value=True), \
                patch.object(installer,'run',side_effect=self.fake_run), \
                patch.object(installer.subprocess,'run',side_effect=self.fake_subprocess), \
                patch.object(installer,'atomic',side_effect=self.fake_atomic), \
                patch.object(installer,'deployed_binary_matches',side_effect=lambda *args:self.match), \
                patch.object(installer.urllib.request,'urlopen',side_effect=self.urlopen), \
                patch('sys.argv',argv),contextlib.redirect_stdout(io.StringIO()) as output:
            installer.main()
        return json.loads(output.getvalue())

    def assert_restored(self,boot='disabled',active=False,target_exists=True):
        self.assertEqual(self.unit.read_bytes(),self.oldunit)
        self.assertTrue(self.system.is_symlink())
        self.assertEqual(self.system.resolve(),self.unit.resolve())
        self.assertEqual(self.target.exists(),target_exists)
        if target_exists:self.assertEqual(self.target.read_bytes(),self.old)
        self.assertEqual(self.boot,boot);self.assertEqual(self.active,active)
        for p,raw in self.protected.items():self.assertEqual(p.read_bytes(),raw)
        self.assertEqual(list(self.root.rglob('*.install-*')),[])

    def test_unit_replace_failure_restores_already_replaced_binary(self):
        self.failure='unit-before-rename'
        with self.assertRaises(OSError):self.execute()
        self.assert_restored()

    def test_binary_fsync_failure_after_rename_is_recovered(self):
        self.failure='binary-fsync'
        with self.assertRaises(OSError):self.execute()
        self.assert_restored()

    def test_unit_fsync_failure_after_rename_is_recovered(self):
        self.failure='unit-fsync'
        with self.assertRaises(OSError):self.execute()
        self.assert_restored()

    def test_partial_enable_failure_restores_boot_state_and_external_link(self):
        self.failure='enable'
        with self.assertRaises(RuntimeError):self.execute()
        self.assert_restored()

    def test_failed_restart_recovers_original_active_service(self):
        self.boot='enabled';self.active=True;self.failure='restart'
        with self.assertRaises(RuntimeError):self.execute()
        self.assert_restored(boot='enabled',active=True)
        self.assertEqual(self.commands.count(('systemctl','restart','ainvr-ai.service')),2)

    def test_failed_restart_does_not_start_previously_stopped_service(self):
        self.failure='restart'
        with self.assertRaises(RuntimeError):self.execute()
        self.assert_restored()
        self.assertIn(('systemctl','stop','ainvr-ai.service'),self.commands)

    def test_wrong_loaded_binary_rejects_deployment_even_if_health_is_good(self):
        self.match=False
        with self.assertRaisesRegex(RuntimeError,'health verification timed out'):self.execute()
        self.assert_restored()

    def test_stale_health_version_rejects_deployment(self):
        self.health['version']='ainvr-s100p-reused-control-0.6'
        with self.assertRaisesRegex(RuntimeError,'health verification timed out'):self.execute()
        self.assert_restored()

    def test_keyboard_interrupt_restores_partial_file_replacements(self):
        self.failure='keyboard-interrupt'
        with self.assertRaises(KeyboardInterrupt):self.execute()
        self.assert_restored()

    def test_sigterm_recovers_partial_swap_and_restores_signal_handler(self):
        original=signal.getsignal(signal.SIGTERM);self.failure='sigterm'
        with self.assertRaises(InterruptedError):self.execute()
        self.assert_restored();self.assertEqual(signal.getsignal(signal.SIGTERM),original)

    def test_failure_removes_only_the_new_target_when_no_target_preexisted(self):
        self.target.unlink();self.failure='unit-fsync'
        with self.assertRaises(OSError):self.execute()
        self.assert_restored(target_exists=False)
        self.assertEqual(self.previous.read_bytes(),elf(b'previous-running-image'))

    def test_concurrent_configuration_change_rejected_before_any_host_mutation(self):
        self.conflict=True
        with self.assertRaisesRegex(RuntimeError,'Concurrent AI configuration'):self.execute()
        self.assertEqual(self.target.read_bytes(),self.old);self.assertEqual(self.unit.read_bytes(),self.oldunit)
        self.assertFalse(any(cmd[0]=='systemctl' for cmd in self.commands))
        self.assertEqual(next(iter(self.protected)).read_bytes(),b'concurrent-user-config')

    def test_success_verifies_candidate_and_preserves_private_configuration(self):
        report=self.execute()
        self.assertTrue(report['restarted_and_healthy']);self.assertTrue(report['business_readiness_preserved'])
        self.assertEqual(report['version'],self.info['version'])
        self.assertEqual(self.target.read_bytes(),self.new)
        self.assertEqual(self.target.stat().st_mode&0o777,0o755)
        for p,raw in self.protected.items():self.assertEqual(p.read_bytes(),raw)

    def test_install_without_start_does_not_restart_or_stop_service(self):
        report=self.execute(start=False)
        self.assertFalse(report['restarted_and_healthy'])
        self.assertFalse(any(cmd[1] in ('restart','stop') for cmd in self.commands if cmd[0]=='systemctl'))


class LoadedBinaryTest(unittest.TestCase):
    def test_checks_kernel_executable_bytes_and_path(self):
        with tempfile.TemporaryDirectory(prefix='ainvr-loaded-binary-test-') as d:
            root=Path(d);target=root/'candidate';target.write_bytes(b'candidate-image')
            proc=root/'proc/123';proc.mkdir(parents=True);(proc/'exe').symlink_to(target)
            digest=hashlib.sha256(target.read_bytes()).hexdigest()
            with patch.object(installer,'PROC_ROOT',root/'proc'):
                self.assertTrue(installer.deployed_binary_matches(123,target,digest))
                self.assertFalse(installer.deployed_binary_matches(123,target,'0'*64))
                self.assertFalse(installer.deployed_binary_matches(0,target,digest))
                self.assertFalse(installer.deployed_binary_matches(999,target,digest))
                alias=root/'same-bytes-different-path';alias.write_bytes(target.read_bytes())
                self.assertFalse(installer.deployed_binary_matches(123,alias,digest))


if __name__=='__main__':unittest.main()
