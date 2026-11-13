#!/usr/bin/env python3
"""Isolated swap regression tests. Requires Linux/root; never uses real swap.

Only allowlisted file utilities and their libraries enter a temporary chroot.
No real /proc, /sys, device nodes, swap tools or systemctl are exposed. Children
lose all capabilities, root privilege-on-exec and privilege escalation. All
swap/zram/sysctl calls are mocks. Temporary files stay next to this test.
Usage: python3 test/test_ainvr_swap.py [--script PATH --service PATH]
"""
import argparse
import ctypes
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest


MOCK = r'''#!/bin/sh
set -eu
name=${0##*/}
. /scenario
case "$name" in
  stat)
    if [ "$1" = -c ] && [ "$2" = %d ]; then
      case "$3" in
        /ssd) echo "${SSD_DEVICE:-2}" ;;
        /ssd/swap) echo "${SWAP_DEVICE:-2}" ;;
        *) echo 1 ;;
      esac
    else /bin/stat.real "$@"; fi
    exit ;;
  mountpoint) [ "${MOUNTED:-1}" = 1 ]; exit ;;
  findmnt) echo "${FSTYPE:-ext4}"; exit ;;
  blkid)
    [ "${PROBE_FAIL:-0}" = 0 ] || exit 2
    for target do :; done
    [ "$(head -c 8 "$target")" = MOCKSWAP ] || exit 2
    echo swap; exit ;;
esac
printf '%s %s\n' "$name" "$*" >> /calls
case "$name" in
  modprobe) [ "${MODPROBE_FAIL:-0}" = 0 ] ;;
  zramctl)
    [ "${ZRAM_FAIL:-0}" = 0 ] || exit 1
    [ "$*" = --find ] || exit 99
    target=/dev/zram0
    [ ! -s "$target" ] && [ "$(cat /sys/block/zram0/disksize 2>/dev/null || echo 0)" = 0 ] || target=/dev/zram1
    : > "$target"
    mkdir -p "/sys/block/${target##*/}"
    case "${ZSTD_AVAILABLE:-0}" in
      1) echo '[lzo] lz4 zstd' ;;
      2) echo 'lzo lz4 [zstd]' ;;
      *) echo '[lzo] lz4' ;;
    esac > "/sys/block/${target##*/}/comp_algorithm"
    echo 0 > "/sys/block/${target##*/}/disksize"
    echo "$target" ;;
  mkswap)
    [ "$(/bin/stat.real -c %a "$1")" = 600 ] || [ "${1#/dev/}" != "$1" ]
    [ "${MKSWAP_FAIL:-0}" = 0 ] || exit 1
    printf MOCKSWAP | dd of="$1" conv=notrunc status=none ;;
  swapon)
    [ "${SWAPON_FAIL:-0}" = 0 ] || exit 1
    [ "$(head -c 8 "$3")" = MOCKSWAP ] || exit 1
    printf '%s\tfile\t1024\t0\t%s\n' "$3" "$2" >> /proc/swaps ;;
  swapoff) echo 'FORBIDDEN swapoff' >&2; exit 99 ;;
  sysctl)
    [ "${SYSCTL_FAIL:-0}" = 0 ] || exit 1
    printf '%s\n' "${3#*=}" > /proc/sys/vm/swappiness ;;
  fallocate)
    [ "${ALLOC_FAIL:-0}" = 0 ] || exit 1
    /bin/fallocate.real "$@"
    case "${INTERRUPT:-none}" in
      term) kill -TERM "$PPID"; exit 1 ;;
      kill) kill -KILL "$PPID"; exit 1 ;;
    esac ;;
  mv)
    [ "${RENAME_FAIL:-0}" = 0 ] || exit 1
    if [ "${RACE:-0}" = 1 ]; then printf EXTERNAL > "$3"; fi
    /bin/mv.real "$@" ;;
  sync) [ "${SYNC_FAIL:-0}" = 0 ] ;;
  *) echo "unexpected mock $name" >&2; exit 99 ;;
esac
'''


def jail(root):
    """Called only in the child. No mounts/namespaces/system config changes."""
    os.chroot(root)
    os.chdir('/')
    libc = ctypes.CDLL(None, use_errno=True)
    # SECBIT_NOROOT + LOCKED; PR_SET_NO_NEW_PRIVS.
    for option, value in ((28, 3), (38, 1)):
        if libc.prctl(option, value, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), 'cannot restrict child privileges')

    class Header(ctypes.Structure):
        _fields_ = [('version', ctypes.c_uint32), ('pid', ctypes.c_int)]

    class Data(ctypes.Structure):
        _fields_ = [('effective', ctypes.c_uint32),
                    ('permitted', ctypes.c_uint32), ('inheritable', ctypes.c_uint32)]

    header, data = Header(0x20080522, 0), (Data * 2)()
    if libc.capset(ctypes.byref(header), ctypes.byref(data)) != 0:
        raise OSError(ctypes.get_errno(), 'cannot drop capabilities')


def copy_binary(root, source, destination):
    target = root / destination.lstrip('/')
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    result = subprocess.run(['ldd', source], check=True, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    for lib in re.findall(r'(/[^\s()]+)', result.stdout):
        dest = root / lib.lstrip('/')
        if not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(lib, dest)


class SwapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='.ainvr-swap-mock-',
                                               dir=Path(__file__).resolve().parent)
        cls.base = Path(cls.temp.name) / 'base'
        cls.base.mkdir()
        commands = ('sh', 'cat', 'awk', 'grep', 'stat', 'mkdir', 'chmod', 'mktemp', 'rm',
                    'mv', 'cmp', 'flock', 'readlink', 'id', 'dd', 'head', 'fallocate')
        for command in commands:
            source = shutil.which(command)
            if not source:
                raise RuntimeError(f'missing file utility: {command}')
            dest = command + '.real' if command in ('stat', 'fallocate', 'mv') else command
            copy_binary(cls.base, source, '/bin/' + dest)
        for command in ('stat', 'mountpoint', 'findmnt', 'blkid', 'modprobe',
                        'zramctl', 'mkswap', 'swapon', 'swapoff', 'sysctl',
                        'fallocate', 'mv', 'sync'):
            dest = cls.base / 'bin' / command
            dest.write_text(MOCK)
            dest.chmod(0o755)
        shutil.copyfile(ARGS.script, cls.base / 'script')

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.root = Path(self.temp.name) / self._testMethodName
        shutil.copytree(self.base, self.root, copy_function=os.link)
        for path in ('proc/sys/vm', 'sys/block', 'dev', 'run', 'ssd/swap'):
            (self.root / path).mkdir(parents=True, exist_ok=True)
        (self.root / 'proc/swaps').write_text('Filename\tType\tSize\tUsed\tPriority\n')
        (self.root / 'proc/sys/vm/swappiness').write_text('60\n')
        # Regular fake zero source: no device node is created.
        (self.root / 'dev/zero').write_bytes(bytes(2 * 1024 * 1024))
        (self.root / 'scenario').write_text('')
        self.file = self.root / 'ssd/swap/ainvr.swap'

    def tearDown(self):
        self.assertNotIn('swapoff ', self.calls())
        self.assertFalse((self.root / 'sys/block/zram0/reset').exists())

    def scenario(self, **values):
        (self.root / 'scenario').write_text('\n'.join(f'{k}={v}' for k, v in values.items()))

    def calls(self):
        path = self.root / 'calls'
        return path.read_text() if path.exists() else ''

    def invoke(self, action='start', ok=True, **env):
        result = subprocess.run(['/bin/sh', '/script', action],
            env={'PATH': '/bin', 'LC_ALL': 'C', 'AINVR_SWAP_SSD': '/ssd',
                 'AINVR_SWAP_ZRAM_MIB': '0', 'AINVR_SWAP_FILE_MIB': '1', **env},
            preexec_fn=lambda: jail(self.root), text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def existing(self, data=b'MOCKSWAP', size=1024 * 1024):
        self.file.write_bytes(data + bytes(size - len(data)))
        self.file.chmod(0o600)

    def active(self, path):
        with (self.root / 'proc/swaps').open('a') as stream:
            stream.write(f'{path}\tfile\t1024\t0\t10\n')

    def test_new_file_and_idempotent_start(self):
        self.invoke()
        self.assertEqual(self.file.stat().st_size, 1024 * 1024)
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o600)
        self.assertTrue(self.file.read_bytes().startswith(b'MOCKSWAP'))
        calls = self.calls()
        self.assertLess(calls.index('mkswap '), calls.index('mv '))
        self.assertLess(calls.index('mv '), calls.index('swapon '))
        self.invoke()
        self.assertEqual(self.calls().count('mkswap '), 1)
        self.assertEqual(self.calls().count('swapon '), 1)

    def test_legacy_equal_size_all_zero_recovers(self):
        self.existing(b'')
        self.invoke()
        self.assertIn('mkswap /ssd/swap/ainvr.swap', self.calls())

    def test_valid_inactive_file_reused_without_formatting(self):
        self.existing()
        self.file.chmod(0o644)
        self.invoke()
        self.assertNotIn('mkswap ', self.calls())
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o600)

    def test_unknown_data_and_probe_failure_preserved(self):
        self.existing(b'IMPORTANT')
        before = self.file.read_bytes()
        self.invoke(ok=False)
        self.assertEqual(self.file.read_bytes(), before)
        self.assertNotIn('mkswap ', self.calls())
        self.existing()
        self.scenario(PROBE_FAIL=1)
        self.invoke(ok=False)
        self.assertTrue(self.file.read_bytes().startswith(b'MOCKSWAP'))

    def test_size_mismatch_preserved(self):
        self.existing(size=512 * 1024)
        self.invoke(ok=False)
        self.assertEqual(self.file.stat().st_size, 512 * 1024)
        self.assertEqual(self.calls(), '')

    def test_external_active_swaps_untouched(self):
        self.existing(b'EXTERNAL', size=512 * 1024)
        self.active('/ssd/swap/ainvr.swap')
        self.active('/dev/zram7')
        self.invoke(AINVR_SWAP_ZRAM_MIB='2')
        self.assertEqual(self.calls(), 'sysctl -q -w vm.swappiness=10\n')
        self.assertTrue(self.file.read_bytes().startswith(b'EXTERNAL'))

    def test_exact_active_path_matching(self):
        self.existing()
        self.active('/ssd/swap/ainvrXswap')
        self.invoke()
        self.assertIn('swapon -p 10 /ssd/swap/ainvr.swap', self.calls())

    def test_external_inactive_zram_untouched(self):
        external = self.root / 'dev/zram0'
        external.write_bytes(b'EXTERNAL')
        self.invoke(AINVR_SWAP_ZRAM_MIB='2', AINVR_SWAP_FILE_MIB='0')
        self.assertEqual(external.read_bytes(), b'EXTERNAL')
        self.assertIn('mkswap /dev/zram1', self.calls())
        self.assertNotIn('reset', self.calls())

    def test_no_ssd_mount_still_allows_zram(self):
        self.scenario(MOUNTED=0)
        self.invoke(AINVR_SWAP_ZRAM_MIB='2')
        self.assertFalse(self.file.exists())
        self.assertIn('swapon -p 100 /dev/zram0', self.calls())

    def test_zstd_selected_only_when_advertised(self):
        for available, expected in ((1, 'zstd\n'), (2, 'zstd\n'), (0, '[lzo] lz4\n')):
            with self.subTest(available=available):
                self.scenario(ZSTD_AVAILABLE=available)
                self.invoke(AINVR_SWAP_ZRAM_MIB='2', AINVR_SWAP_FILE_MIB='0')
                sysfs = self.root / 'sys/block/zram0'
                self.assertEqual((sysfs / 'comp_algorithm').read_text(), expected)
                self.assertEqual((sysfs / 'disksize').read_text(), '2M\n')
                self.assertFalse((sysfs / 'reset').exists())
                (self.root / 'dev/zram0').unlink()
                (sysfs / 'disksize').write_text('0\n')
                (self.root / 'proc/swaps').write_text('Filename Type Size Used Priority\n')
        self.assertEqual(self.calls().count('zramctl --find\n'), 3)
        self.assertEqual(self.calls().count('mkswap '), 3)
        self.assertEqual(self.calls().count('swapon '), 3)

    def test_root_filesystem_and_unsupported_fs_rejected(self):
        for scenario in ({'SSD_DEVICE': 1}, {'FSTYPE': 'btrfs'}, {'SWAP_DEVICE': 1}):
            with self.subTest(scenario=scenario):
                self.scenario(**scenario)
                self.invoke(ok=False)
                self.assertEqual(self.calls(), '')

    def test_invalid_configuration_rejected_before_mutation(self):
        for name, value in [('AINVR_SWAP_FILE_MIB', '-1'), ('AINVR_SWAP_FILE_MIB', '01'),
                            ('AINVR_SWAP_FILE_MIB', '99999999999999999999'),
                            ('AINVR_SWAP_ZRAM_MIB', '1;id'), ('AINVR_SWAPPINESS', '201'),
                            ('AINVR_SWAP_SSD', '/'), ('AINVR_SWAP_SSD', '/ssd space'),
                            ('AINVR_SWAP_SSD', '/ssd\\path'), ('AINVR_SWAP_SSD', 'relative')]:
            with self.subTest(name=name, value=value):
                self.invoke(ok=False, **{name: value})
                self.assertEqual(self.calls(), '')
                self.assertFalse((self.root / 'run/ainvr-swap').exists())

    def test_disabled_layers(self):
        self.invoke(AINVR_SWAP_FILE_MIB='0')
        self.assertEqual(self.calls(), 'sysctl -q -w vm.swappiness=10\n')

    def test_symlink_file_rejected(self):
        victim = self.root / 'victim'
        victim.write_text('KEEP')
        self.file.symlink_to('/victim')
        self.invoke(ok=False)
        self.assertEqual(victim.read_text(), 'KEEP')
        self.assertEqual(self.calls(), '')

    def test_dangling_symlink_file_rejected(self):
        self.file.symlink_to('/absent')
        self.invoke(ok=False)
        self.assertFalse((self.root / 'absent').exists())

    def test_hardlinked_file_rejected(self):
        self.existing(b'')
        os.link(self.file, self.root / 'victim')
        self.invoke(ok=False)
        self.assertEqual(self.calls(), '')

    def test_nonregular_file_rejected(self):
        self.file.mkdir()
        self.invoke(ok=False)
        self.assertEqual(self.calls(), '')

    def test_unsafe_directory_rejected(self):
        for path in (self.root / 'ssd', self.root / 'ssd/swap'):
            with self.subTest(path=path.name):
                path.chmod(0o777)
                self.invoke(ok=False)
                self.assertEqual(self.calls(), '')
                path.chmod(0o755)

    def test_symlink_directory_rejected(self):
        (self.root / 'ssd/swap').rmdir()
        (self.root / 'victim').mkdir()
        (self.root / 'ssd/swap').symlink_to('/victim')
        self.invoke(ok=False)
        self.assertEqual(list((self.root / 'victim').iterdir()), [])

    def test_nonroot_owned_paths_rejected(self):
        self.existing()
        for path in (self.root / 'ssd', self.file.parent, self.file):
            with self.subTest(path=str(path)):
                os.chown(path, 1000, 1000)
                self.invoke(ok=False)
                self.assertEqual(self.calls(), '')
                os.chown(path, 0, 0)

    def test_symlink_mount_rejected(self):
        (self.root / 'alias').symlink_to('/ssd')
        self.invoke(ok=False, AINVR_SWAP_SSD='/alias')
        self.assertEqual(self.calls(), '')

    def test_runtime_symlinks_and_hardlinks_rejected(self):
        directory = self.root / 'run/ainvr-swap'
        victim = self.root / 'victim'
        victim.write_text('KEEP')
        directory.symlink_to('/ssd')
        self.invoke(ok=False)
        directory.unlink()
        directory.mkdir()
        lock = directory / 'lock'
        lock.symlink_to('/victim')
        self.invoke(ok=False)
        lock.unlink()
        os.link(victim, lock)
        self.invoke(ok=False)
        self.assertEqual(victim.read_text(), 'KEEP')
        self.assertEqual(self.calls(), '')

    def test_failed_allocation_or_format_not_published(self):
        for flag in ('ALLOC_FAIL', 'MKSWAP_FAIL', 'SYNC_FAIL', 'RENAME_FAIL'):
            with self.subTest(flag=flag):
                self.scenario(**{flag: 1})
                self.invoke(ok=False)
                self.assertFalse(self.file.exists())
                self.assertEqual(list(self.file.parent.glob('.ainvr.swap.*')), [])
        self.scenario()
        self.invoke()

    def test_sigterm_cleanup_and_retry(self):
        self.scenario(INTERRUPT='term')
        self.invoke(ok=False)
        self.assertFalse(self.file.exists())
        self.assertEqual(list(self.file.parent.glob('.ainvr.swap.*')), [])
        self.scenario()
        self.invoke()

    def test_sigkill_orphan_does_not_block_retry(self):
        self.scenario(INTERRUPT='kill')
        self.invoke(ok=False)
        self.assertFalse(self.file.exists())
        orphans = list(self.file.parent.glob('.ainvr.swap.*'))
        self.assertEqual(len(orphans), 1)
        self.assertEqual(orphans[0].stat().st_mode & 0o777, 0o600)
        self.scenario()
        self.invoke()
        self.assertTrue(orphans[0].exists())

    def test_racing_creator_is_not_overwritten(self):
        self.scenario(RACE=1)
        self.invoke(ok=False)
        self.assertEqual(self.file.read_bytes(), b'EXTERNAL')
        self.assertEqual(list(self.file.parent.glob('.ainvr.swap.*')), [])

    def test_swapon_failure_retains_formatted_file_for_retry(self):
        self.scenario(SWAPON_FAIL=1)
        self.invoke(ok=False)
        self.assertTrue(self.file.read_bytes().startswith(b'MOCKSWAP'))
        self.scenario()
        self.invoke()
        self.assertEqual(self.calls().count('mkswap '), 1)

    def test_zram_failures_are_reported_without_reset(self):
        for flag in ('MODPROBE_FAIL', 'ZRAM_FAIL', 'MKSWAP_FAIL', 'SWAPON_FAIL'):
            with self.subTest(flag=flag):
                self.scenario(**{flag: 1})
                self.invoke(ok=False, AINVR_SWAP_FILE_MIB='0', AINVR_SWAP_ZRAM_MIB='2')
        self.assertNotIn('sysctl ', self.calls())

    def test_sysctl_failure_is_reported(self):
        self.scenario(SYSCTL_FAIL=1)
        self.invoke(ok=False, AINVR_SWAP_FILE_MIB='0')

    def test_lock_prevents_concurrent_start(self):
        import fcntl
        directory = self.root / 'run/ainvr-swap'
        directory.mkdir()
        with (directory / 'lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.invoke(ok=False)
        self.assertEqual(self.calls(), '')

    def test_stop_leaves_everything_unchanged(self):
        self.existing()
        self.active('/dev/zram0')
        self.active('/ssd/swap/ainvr.swap')
        before = (self.root / 'proc/swaps').read_bytes()
        self.invoke('stop')
        self.assertEqual((self.root / 'proc/swaps').read_bytes(), before)
        self.assertEqual(self.calls(), '')

    def test_status_and_usage(self):
        self.assertIn('swappiness 60', self.invoke('status').stdout)
        self.assertEqual(self.invoke('invalid', ok=False).returncode, 2)
        self.assertEqual(self.calls(), '')

    def test_service_has_no_implicit_swap_teardown(self):
        directives = [line for line in Path(ARGS.service).read_text().splitlines()
                      if line and not line.startswith('#')]
        self.assertFalse(any(line.startswith(('ExecStop=', 'RequiresMountsFor=')) for line in directives))
        self.assertIn('UMask=0077', directives)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    repo = Path(__file__).resolve().parent.parent
    parser.add_argument('--script', default=repo / 'deploy/s100p/ainvr-swap.sh')
    parser.add_argument('--service', default=repo / 'deploy/s100p/ainvr-swap.service')
    ARGS = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('root required for chroot; real system commands are never used')
    unittest.main(argv=[__file__], verbosity=2)
