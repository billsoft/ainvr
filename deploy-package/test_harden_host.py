"""harden-host.sh：新板到手后必须做的主机调整（目前：关闭桌面文件索引器）。

2026-10-01 实测：板子默认是图形界面，GNOME 的 tracker-miner-fs / tracker-extract 在服务器上没有用处，
却会反复读写 12GB 的容器目录；每一次系统盘卡顿（ext4 日志 jbd2 阻塞）时它们都在 D 状态里。
授权服务要在持锁时同步落盘，盘一卡就答不上请求，租约到期、授权执行器停掉流媒体服务。

脚本必须：幂等、可逆（只 mask，不删文件）、只动 ainvr 用户的用户级单元、不存在的单元不报错、
在桌面会话不存在（无头）时也能用，并且 --check 只读不改。
这里用假的 runuser/systemctl 记录调用，验证调用序列，不碰真实系统。
"""
from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).with_name('harden-host.sh')


def fake_bin(tmp_path, existing_units=("tracker-miner-fs-3.service", "tracker-extract-3.service"), masked=()):
    """造一个假的 PATH：runuser 直接执行后面的命令，systemctl 记录调用并按设定回答。"""
    bindir = tmp_path / 'bin'
    bindir.mkdir()
    log = tmp_path / 'calls.log'
    (bindir / 'runuser').write_text(
        '#!/bin/bash\n# runuser -u ainvr -- env XDG_RUNTIME_DIR=.. DBUS..=.. systemctl ...\n'
        'while [ "$1" != "--" ]; do shift; done; shift\nexec "$@"\n')
    (bindir / 'env').write_text('#!/bin/bash\nwhile [[ "$1" == *=* ]]; do shift; done\nexec "$@"\n')
    (bindir / 'id').write_text('#!/bin/bash\nif [ "$1" = "-u" ] && [ "$2" = "ainvr" ]; then echo 1000; else /usr/bin/id "$@"; fi\n')
    (bindir / 'systemctl').write_text(f'''#!/bin/bash
echo "systemctl $*" >> {log}
args=("$@")
case "$*" in
  *"show "*)
    if [[ "$FAKE_USER_BUS_DOWN" == 1 ]]; then echo "Failed to connect to bus" >&2; exit 1; fi
    for u in {' '.join(masked)}; do [[ "$*" == *"$u"* ]] && echo masked && exit 0; done
    for u in {' '.join(existing_units)}; do [[ "$*" == *"$u"* ]] && echo loaded && exit 0; done
    echo not-found; exit 0 ;;
  *"mask --now "*)
    if [[ -n "$FAKE_MASK_FAIL_UNIT" && "$*" == *"$FAKE_MASK_FAIL_UNIT"* ]]; then exit 1; fi
    exit 0 ;;
  *"cat "*) for u in {' '.join(existing_units)}; do [[ "$*" == *"$u"* ]] && exit 0; done; exit 1 ;;
  *"is-enabled "*) for u in {' '.join(masked)}; do [[ "$*" == *"$u"* ]] && echo masked && exit 0; done; echo enabled; exit 0 ;;
  *) exit 0 ;;
esac
''')
    for f in bindir.iterdir():
        f.chmod(f.stat().st_mode | stat.S_IEXEC)
    return bindir, log


def run(tmp_path, *args, units=("tracker-miner-fs-3.service", "tracker-extract-3.service"), masked=(), uid_root=True,
        bus_down=False, mask_fail_unit=''):
    bindir, log = fake_bin(tmp_path, units, masked)
    env = {**os.environ, 'PATH': f'{bindir}:{os.environ["PATH"]}', 'HARDEN_ASSUME_ROOT': '1' if uid_root else '0',
           'HARDEN_RUNTIME_DIR_BASE': str(tmp_path / 'run'),
           'FAKE_USER_BUS_DOWN': '1' if bus_down else '0',
           'FAKE_MASK_FAIL_UNIT': mask_fail_unit}
    (tmp_path / 'run' / '1000').mkdir(parents=True)
    r = subprocess.run(['bash', str(SCRIPT), *args], capture_output=True, text=True, env=env, timeout=30)
    return r, (log.read_text() if log.exists() else '')


def test_masks_the_indexer_units_for_the_ainvr_user_only(tmp_path):
    r, calls = run(tmp_path)
    assert r.returncode == 0, r.stderr
    assert masked_units(calls) == {"tracker-miner-fs-3.service", "tracker-extract-3.service"}
    assert all('--user' in l for l in calls.splitlines() if ' mask ' in l)   # 全是用户级单元
    assert 'systemctl set-default' not in calls and 'isolate' not in calls   # 不动桌面本身
    assert 'disable' not in calls.replace('disable-', '')


def masked_units(calls: str) -> set[str]:
    """从调用记录里取出被 `systemctl --user mask ...` 实际屏蔽的单元集合。"""
    out: set[str] = set()
    for line in calls.splitlines():
        parts = line.split()
        if parts[:2] == ['systemctl', '--user'] and 'mask' in parts and 'unmask' not in parts:
            out |= {x for x in parts if x.endswith('.service')}
    return out


def test_units_that_do_not_exist_are_skipped_quietly(tmp_path):
    r, calls = run(tmp_path, units=("tracker-miner-fs-3.service",))     # 只有一个存在
    assert r.returncode == 0, r.stderr
    assert masked_units(calls) == {"tracker-miner-fs-3.service"}         # 不存在的既不报错、也不去屏蔽


def test_is_idempotent_when_already_masked(tmp_path):
    r, calls = run(tmp_path, masked=("tracker-miner-fs-3.service", "tracker-extract-3.service"))
    assert r.returncode == 0, r.stderr
    assert masked_units(calls) == set()                                  # 已经屏蔽的不重复动


def test_check_mode_reads_only_and_reports(tmp_path):
    r, calls = run(tmp_path, '--check')
    assert 'mask' not in calls and 'unmask' not in calls
    assert 'tracker-miner-fs-3' in r.stdout
    # 还没屏蔽时 --check 要给出非零退出码，便于验收脚本发现漏做
    assert r.returncode != 0


def test_check_mode_passes_when_everything_is_masked(tmp_path):
    r, _ = run(tmp_path, '--check', masked=("tracker-miner-fs-3.service", "tracker-extract-3.service"))
    assert r.returncode == 0, r.stdout + r.stderr


def test_refuses_to_run_without_root_unless_check(tmp_path):
    r, calls = run(tmp_path, uid_root=False)
    assert r.returncode != 0 and 'mask' not in calls


def test_unavailable_user_bus_is_a_failure_not_missing_units(tmp_path):
    r, calls = run(tmp_path, bus_down=True)
    assert r.returncode != 0
    assert '无法查询' in r.stderr
    assert not masked_units(calls)


def test_check_also_fails_when_the_user_bus_is_unavailable(tmp_path):
    r, calls = run(tmp_path, '--check', bus_down=True)
    assert r.returncode != 0
    assert not masked_units(calls)


def test_failed_mask_is_reported_even_when_later_units_succeed(tmp_path):
    r, calls = run(tmp_path, mask_fail_unit='tracker-miner-fs-3.service')
    assert r.returncode != 0
    assert 'tracker-miner-fs-3.service: 屏蔽失败' in r.stderr
    assert 'tracker-extract-3.service: 已屏蔽' in r.stdout
