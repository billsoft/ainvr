"""GB deployment checks using fake artifacts and a fake systemctl only."""
import hashlib
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('verify_gb_install', ROOT/'deploy-package/gb28181/verify_install.py')
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class DeploymentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)/'repository'
        self.output = self.root/'out/gb28181'
        self.paths = [self.output/'gateway', self.output/'ZLMediaKit/release/linux/Release/MediaServer',
                      self.output/'ffmpeg-runtime/bin/ffmpeg', self.output/'ffmpeg-runtime/bin/ffprobe']
        header = bytearray(20)
        header[:6] = b'\x7fELF\x02\x01'
        header[18:20] = b'\xb7\x00'
        for index, path in enumerate(self.paths):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(header+bytes([index]))
        self.candidate = self.output/'gateway-accepted'
        self.candidate.write_bytes(header+b'accepted')
        self.lock = {'zlmediakit': {'arm64BinarySha256': CHECK.sha(self.paths[1])},
                     'ffmpeg': {'installedArm64BinarySha256': CHECK.sha(self.paths[2]),
                                'installedArm64ProbeSha256': CHECK.sha(self.paths[3])}}
        (self.root/'gb28181-service').mkdir()
        (self.root/'gb28181-service/dependencies.lock.json').write_text(json.dumps(self.lock))
        notices = self.output/'licenses'
        notices.mkdir()
        (notices/'LICENSE').write_text('fixture notice')
        (notices/'inventory.json').write_text(json.dumps([{'notice': 'LICENSE', 'sha256': CHECK.sha(notices/'LICENSE')}]))
        migration = self.root/'srs-web-console/backend/dist/store/migrations/012_gb28181.sql'
        migration.parent.mkdir(parents=True)
        migration.write_text('-- fixture migration')

    def manifest(self):
        (self.output/'artifacts.sha256').write_text(''.join(f'{CHECK.sha(p)}  {p}\n' for p in self.paths))

    def test_default_requires_complete_manifest_and_rejects_stale_gateway(self):
        with self.assertRaises(FileNotFoundError):
            CHECK.verify(self.root)
        self.manifest()
        self.assertTrue(CHECK.verify(self.root)['verified'])
        self.paths[0].write_bytes(b'changed')
        with self.assertRaises(ValueError):
            CHECK.verify(self.root)

    def test_explicit_candidate_is_bound_to_accepted_hash(self):
        result = CHECK.verify(self.root, self.candidate, CHECK.sha(self.candidate))
        self.assertEqual(result['gateway'], str(self.candidate))
        with self.assertRaises(ValueError):
            CHECK.verify(self.root, self.candidate)
        with self.assertRaises(ValueError):
            CHECK.verify(self.root, self.candidate, '0'*64)

    def test_rejects_outside_candidate_and_changed_media(self):
        outside = Path(self.temp.name)/'other'
        shutil.copyfile(self.candidate, outside)
        with self.assertRaises(ValueError):
            CHECK.verify(self.root, outside, CHECK.sha(outside))
        self.paths[2].write_bytes(b'different media binary')
        with self.assertRaises(ValueError):
            CHECK.verify(self.root, self.candidate, CHECK.sha(self.candidate))

    def test_notices_and_machine_architecture_are_verified(self):
        bad = self.output/'licenses/LICENSE'
        bad.write_text('changed')
        with self.assertRaises(ValueError):
            CHECK.verify(self.root, self.candidate, CHECK.sha(self.candidate))
        bad.write_text('fixture notice')
        self.candidate.write_bytes(b'not an ELF executable')
        with self.assertRaises(ValueError):
            CHECK.verify(self.root, self.candidate, CHECK.sha(self.candidate))

    def test_installed_copy_is_verified_before_service_start(self):
        installed = Path(self.temp.name)/'installed'
        (installed/'ffmpeg/bin').mkdir(parents=True)
        for source, target in [(self.candidate, installed/'gateway'), (self.paths[1], installed/'MediaServer'),
                               (self.paths[2], installed/'ffmpeg/bin/ffmpeg'), (self.paths[3], installed/'ffmpeg/bin/ffprobe')]:
            shutil.copyfile(source, target)
        shutil.copytree(self.output/'licenses', installed/'licenses')
        CHECK.verify(self.root, self.candidate, CHECK.sha(self.candidate), installed)
        (installed/'gateway').write_bytes(b'wrong copy')
        with self.assertRaises(ValueError):
            CHECK.verify(self.root, self.candidate, CHECK.sha(self.candidate), installed)

    def rollback_state(self, enabled, active, inherited_lock=False, competing_lock=False):
        sandbox = Path(self.temp.name)/('rollback-'+enabled+'-'+active)
        backup = sandbox/'mnt/ainvr-ssd/ainvr-rollback/gb28181/test'
        backup.mkdir(parents=True)
        (backup/'repository').write_text(str(self.root))
        for unit in ['ainvr-gb28181', 'ainvr-gb-media']:
            (backup/(unit+'.enabled')).write_text(enabled+'\n')
            (backup/(unit+'.active')).write_text(active+'\n')
        state = sandbox/'service-state.json'
        state.write_text(json.dumps({'calls': [], 'services': {u: {'enabled': 'enabled', 'active': True}
                                                            for u in ['ainvr-gb28181', 'ainvr-gb-media']}}))
        commands = sandbox/'bin'
        commands.mkdir()
        mock = commands/'systemctl'
        mock.write_text('''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
p=Path(os.environ['TEST_SERVICE_STATE']);s=json.loads(p.read_text());a=sys.argv[1:];s['calls'].append(a)
for unit in a:
 if unit not in s['services']:continue
 value=s['services'][unit]
 if a[0]=='stop':value['active']=False
 elif a[0]=='start':value['active']=True
 elif a[0]=='disable':value['enabled']='disabled'
 elif a[0]=='enable':value['enabled']='enabled-runtime' if '--runtime' in a else 'enabled'
p.write_text(json.dumps(s))
''')
        mock.chmod(0o755)
        original = (ROOT/'deploy-package/gb28181/rollback.sh').read_text()
        # Only a disposable script copy receives filesystem-root substitutions;
        # the real installer, /etc, /opt and systemctl are never executed here.
        # This suite verifies service enablement only. Mounted-storage validation
        # is independently covered in test_backup_policy.py.
        script = original.replace('python3 "$ROOT/deploy-package/gb28181/backup_policy.py" --check "$BACKUP"', 'test -f "$BACKUP/repository"')
        script = script.replace('/opt/ainvr', str(sandbox/'opt/ainvr'))
        script = script.replace('/run/lock/ainvr-ptz-deploy.lock', str(sandbox/'deploy.lock'))
        script = script.replace('"/$path"', '"'+str(sandbox)+'/$path"')
        runner = sandbox/'rollback.sh'
        runner.write_text(script)
        env = {**os.environ, 'PATH': str(commands)+':'+os.environ['PATH'], 'TEST_SERVICE_STATE': str(state)}
        env.pop('AINVR_GB_DEPLOY_LOCK_HELD', None)
        command = ['sh', str(runner), str(backup)]
        if inherited_lock:
            command = ['sh', '-c', 'exec 9>"$1"; flock -n 9; AINVR_GB_DEPLOY_LOCK_HELD=1 sh "$2" "$3"',
                       'inherited-test-lock', str(sandbox/'deploy.lock'), str(runner), str(backup)]
        if competing_lock:
            with (sandbox/'deploy.lock').open('w') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = subprocess.run(command, env=env, capture_output=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
        else:
            subprocess.run(command, env=env, check=True, capture_output=True, timeout=10)
        return json.loads(state.read_text())

    def test_rollback_preserves_enabled_but_inactive(self):
        states = self.rollback_state('enabled', 'inactive')
        for value in states['services'].values():
            self.assertEqual(value, {'enabled': 'enabled', 'active': False})

    def test_rollback_preserves_disabled_but_active(self):
        states = self.rollback_state('disabled', 'active')
        for value in states['services'].values():
            self.assertEqual(value, {'enabled': 'disabled', 'active': True})

    def test_rollback_preserves_runtime_enablement(self):
        states = self.rollback_state('enabled-runtime', 'active')
        for value in states['services'].values():
            self.assertEqual(value, {'enabled': 'enabled-runtime', 'active': True})

    def test_automatic_rollback_can_use_the_parent_install_lock(self):
        states = self.rollback_state('enabled', 'inactive', inherited_lock=True)
        for value in states['services'].values():
            self.assertEqual(value, {'enabled': 'enabled', 'active': False})

    def test_competing_rollback_fails_before_service_changes(self):
        states = self.rollback_state('enabled', 'active', competing_lock=True)
        self.assertEqual(states['calls'], [])


if __name__ == '__main__':
    unittest.main()
