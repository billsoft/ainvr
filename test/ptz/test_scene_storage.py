"""Run on a board as root for the real backend-identity write/read regression."""
import importlib.util
import os
from pathlib import Path
import pwd
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('scene_storage', ROOT / 'deploy-package/prepare-scene-storage.py')
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


class SceneStorage(unittest.TestCase):
    def test_release_freezes_and_packages_scene_provisioner_with_imports(self):
        spec = importlib.util.spec_from_file_location('release', ROOT / 'deploy-package/build-onvif-release.py')
        release = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(release)
        paths = ['deploy-package/prepare-scene-storage.py', 'deploy-package/validate_console_env.py',
                 'shared/os-helper/storage.py']
        with tempfile.TemporaryDirectory() as temp:
            package = Path(temp)
            release.copy_release_tools(package)
            for profile in ('ptz', 'search'):
                manifest = release.sources(profile)
                for path in paths:
                    self.assertEqual(manifest[path], release.sha(package / path))
            # Isolated import paths; this executes only help, never provisions a live volume.
            result = subprocess.check_output([sys.executable, '-I', '-B', package / paths[0], '--help'],
                                             cwd=temp, text=True)
            self.assertIn('--backend-env', result)
            self.assertFalse((package / 'deploy/s100p/runtime/backend.env').exists())

    def test_selection(self):
        volume = dict(id='a', mountPath='/mnt/test', state='mounted', selectable=True,
                      system=False, readOnly=False)
        self.assertEqual(storage.select([volume]), volume)
        for disallowed in [dict(system=True), dict(state='unmounted'), dict(readOnly=True),
                           dict(selectable=False), dict(mountPath='/')]:
            self.assertIsNone(storage.select([dict(volume, **disallowed)]))
        other = dict(volume, id='b', mountPath='/mnt/other')
        self.assertIsNone(storage.select([volume, other]))
        self.assertEqual(storage.select([volume, other], '/mnt/other'), other)
        self.assertIsNone(storage.select([volume, dict(other, id='a')], '/mnt/other'))

    def test_unconfigured_optional_release_skips_before_owner_and_mkdir(self):
        with patch.object(sys, 'argv', ['prepare', '--if-configured']), patch.object(os, 'geteuid', return_value=0), \
                patch.object(storage, 'inventory', return_value={'volumes': []}), \
                patch.object(storage, 'helper_volumes', return_value=[]), patch.object(storage, 'backend_owner') as owner:
            storage.main()
            owner.assert_not_called()

    def test_root_filesystem_and_non_mount_rejected(self):
        with self.assertRaises(ValueError):
            storage.open_volume({'device': '/dev/null', 'mountPath': '/'})
        with tempfile.TemporaryDirectory() as path, self.assertRaises(ValueError):
            storage.open_volume({'device': '/dev/null', 'mountPath': path})

    def test_existing_symlink_and_wrong_mode_fail_without_modifying_target(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fd = os.open(root, storage.DIRECTORY)
            try:
                target = root / 'other'
                target.mkdir(mode=0o755)
                mode = target.stat().st_mode
                link = root / storage.NAMESPACE
                link.symlink_to(target, target_is_directory=True)
                with self.assertRaises(OSError):
                    storage.prepare_namespace(fd, os.getuid(), os.getgid())
                self.assertEqual(target.stat().st_mode, mode)
                link.unlink()
                link.mkdir()
                link.chmod(0o755)
                with self.assertRaises(ValueError):
                    storage.prepare_namespace(fd, os.getuid(), os.getgid())
                self.assertEqual(stat.S_IMODE(link.stat().st_mode), 0o755)
            finally:
                os.close(fd)

    @unittest.skipUnless(os.geteuid() == 0 and os.environ.get('SCENE_STORAGE_TEST_PARENT'),
                         'board integration requires root and a scratch directory on the external volume')
    def test_service_identity_on_external_volume(self):
        uid, gid = storage.backend_owner()
        volume = storage.select(storage.helper_volumes())
        self.assertIsNotNone(volume)
        volume_fd = storage.open_volume(volume)
        self.addCleanup(os.close, volume_fd)
        with tempfile.TemporaryDirectory(dir=os.environ['SCENE_STORAGE_TEST_PARENT']) as temp:
            root = Path(temp)
            root.chmod(0o755)
            self.assertEqual(root.stat().st_dev, os.fstat(volume_fd).st_dev)
            fd = os.open(root, storage.DIRECTORY)
            try:
                storage.prepare_namespace(fd, uid, gid)
                store = root / storage.NAMESPACE
                info = store.stat()
                self.assertEqual((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)), (uid, gid, 0o700))
                self.assertEqual((root.stat().st_uid, stat.S_IMODE(root.stat().st_mode)), (0, 0o755))
                account = pwd.getpwuid(uid)
                write_read = """import os,sys
from pathlib import Path
root = Path(sys.argv[1])
assert not os.access(root, os.W_OK)
file = root / sys.argv[2] / 'probe'
file.write_bytes(b'scene')
assert file.read_bytes() == b'scene'
"""
                subprocess.run([sys.executable, '-c', write_read, temp, storage.NAMESPACE],
                               user=uid, group=gid, extra_groups=os.getgrouplist(account.pw_name, gid), check=True)
                storage.prepare_namespace(fd, uid, gid)
                self.assertEqual(info.st_ino, store.stat().st_ino)
                self.assertEqual((store / 'probe').read_bytes(), b'scene')
            finally:
                os.close(fd)


if __name__ == '__main__':
    unittest.main()
