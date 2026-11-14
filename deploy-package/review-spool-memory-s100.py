#!/usr/bin/env python3
"""AINVR S100/S100P: review-frame handoff spool (raw/) on a bounded memory filesystem.

raw/ only hands frames from the AI service to the alarm service (about 35 s per
frame). Frames an alarm references are copied into the alarm image store; frames
of an active alarm checkpoint are pinned. Keeping this churn (15 frames/s, three
syncs per frame) on the SSD stalled every other durable write on the board.
pinned/, candidates/, reference/ and the policy/status files stay on the SSD.

After a power loss the memory spool is empty: observations journaled in the last
seconds then publish their alarm without a screenshot (source_frame_missing).

Run as root:  --apply [--size 384m]   or   --rollback
"""
import argparse, json, os, pwd, shutil, subprocess, time
from pathlib import Path

SSD = Path('/mnt/ainvr-ssd')
CACHE = SSD / 'ainvr-review-frames'
RAW = CACHE / 'raw'
ROLLBACK = SSD / 'ainvr-rollback' / 'review-spool'
OBSERVATIONS = SSD / 'observations'
MARK = '# Managed by AINVR review spool'
UNITS = ['ainvr-ai', 'ainvr-alarm', 'ainvr-review-reference']
STOP_ORDER = ['ainvr-ai', 'ainvr-review-reference', 'ainvr-alarm']
DROPIN = '/etc/systemd/system/{}.service.d/45-review-spool.conf'
RECENT_SECONDS = 600  # unacknowledged frames older than this belong to deleted channels


def run(*args, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True, timeout=180)


def mount_unit():
    return run('systemd-escape', '--path', '--suffix=mount', str(RAW)).stdout.strip()


def is_memory_mount():
    r = run('findmnt', '-no', 'FSTYPE', str(RAW), check=False)
    return r.returncode == 0 and r.stdout.strip() == 'tmpfs'


def stop_services():
    for unit in STOP_ORDER:
        run('systemctl', 'stop', unit)
        if unit == 'ainvr-ai':
            wait_journal_drain()


def start_services():
    for unit in reversed(STOP_ORDER):
        run('systemctl', 'start', unit)
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        if all(run('systemctl', 'is-active', u, check=False).stdout.strip() == 'active' for u in UNITS):
            return
        time.sleep(1)
    raise RuntimeError('services did not become active')


def journal_records():
    return sum(1 for d in OBSERVATIONS.iterdir() if d.is_dir() for f in d.iterdir() if f.suffix == '.json') if OBSERVATIONS.is_dir() else 0


def wait_journal_drain():
    # Records of deleted channels never drain: wait until the count stops falling.
    last, steady, deadline = journal_records(), 0, time.monotonic() + 90
    while time.monotonic() < deadline and steady < 10:
        time.sleep(1)
        now = journal_records()
        steady = steady + 1 if now >= last else 0
        last = now


def captured_channels():
    try:
        channels = json.loads((CACHE / 'enabled.json').read_text()).get('channels')
        return set(channels) if isinstance(channels, list) else None
    except (OSError, ValueError):
        return None


def frame_channel(src, key):
    try:
        return json.loads((src / (key + '.json')).read_text()).get('channel_id')
    except (OSError, ValueError):
        return None


def migrate(src, dst, owner, captured=None):
    """Copy what a consumer can still need: pinned frames and recent unacknowledged ones.

    A frame pinned for over RECENT_SECONDS by a channel that is no longer captured
    belongs to a deleted channel whose pins were never released (.189: 16 stress
    test channels left 114k pins on ~100 frames); it stays in the SSD copy only.
    Without a readable capture list (None) every pinned frame is kept.
    """
    names = set(os.listdir(src))
    keys = {n[:-4] for n in names if n.endswith('.jpg')}
    pins = [n for n in names if n.endswith('.pin')]
    pinned = {p[:64] for p in pins}
    now, chosen = time.time(), set()
    for k in keys:
        recent = now - (src / (k + '.jpg')).stat().st_mtime < RECENT_SECONDS
        if k in pinned:
            if captured is None or recent or frame_channel(src, k) in captured:
                chosen.add(k)
        elif k + '.ack' not in names and recent:
            chosen.add(k)
    need = sum((src / (k + e)).stat().st_size for k in chosen for e in ('.jpg', '.json') if k + e in names)
    free = shutil.disk_usage(dst).free
    if need > free // 2:
        raise RuntimeError(f'frames to keep ({need} bytes) exceed half of the target spool ({free})')
    for k in chosen:
        for e in ('.json', '.jpg'):  # metadata first; a consumer validates the pair
            if k + e in names:
                shutil.copy2(src / (k + e), dst / (k + e))
                os.chown(dst / (k + e), owner.pw_uid, owner.pw_gid)
    if pins:
        anchor = dst / '.pin-anchor'
        anchor.write_text('1')
        os.chown(anchor, owner.pw_uid, owner.pw_gid)
        os.chmod(anchor, 0o600)
        for p in pins:
            if p[:64] in chosen and not (dst / p).exists():
                os.link(anchor, dst / p)
    os.sync()
    return {'frames': len(chosen), 'pinned': len(pinned & chosen), 'pins': len(pins), 'bytes': need,
            'left_behind': len(keys - chosen)}


def write_config(size, owner):
    lines = Path('/etc/fstab').read_text().splitlines()
    kept, skip = [], False
    for line in lines:
        if line == MARK:
            skip = True
            continue
        if skip:
            skip = False
            continue
        kept.append(line)
    if any(str(RAW) in l.split() for l in kept if not l.lstrip().startswith('#')):
        raise RuntimeError('Unmanaged fstab entry for ' + str(RAW))
    entry = (f'tmpfs {RAW} tmpfs size={size},mode=0700,uid={owner.pw_uid},gid={owner.pw_gid},'
             'noatime,nosuid,nodev,noexec,x-systemd.requires-mounts-for=/mnt/ainvr-ssd 0 0')
    tmp = Path('/etc/fstab.ainvr-tmp')
    tmp.write_text('\n'.join(kept + [MARK, entry]) + '\n')
    os.chmod(tmp, 0o644)
    tmp.replace('/etc/fstab')
    for unit in UNITS:
        path = Path(DROPIN.format(unit))
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and not path.read_text().startswith(MARK):
            raise RuntimeError('Refusing unrelated configuration: ' + str(path))
        path.write_text(f'{MARK}\n[Unit]\nRequiresMountsFor={RAW}\n')
    run('systemctl', 'daemon-reload')


def remove_config():
    text = Path('/etc/fstab').read_text().splitlines()
    out, skip = [], False
    for line in text:
        if line == MARK:
            skip = True
            continue
        if skip:
            skip = False
            continue
        out.append(line)
    tmp = Path('/etc/fstab.ainvr-tmp')
    tmp.write_text('\n'.join(out) + '\n')
    os.chmod(tmp, 0o644)
    tmp.replace('/etc/fstab')
    for unit in UNITS:
        path = Path(DROPIN.format(unit))
        if path.exists() and path.read_text().startswith(MARK):
            path.unlink()
    run('systemctl', 'daemon-reload')


def prune_rollbacks():
    if ROLLBACK.is_dir():
        for old in sorted(p for p in ROLLBACK.iterdir() if p.is_dir())[:-3]:
            shutil.rmtree(old)


AI_BIN = Path('/home/sunrise/ainvr/deploy/s100p/bin/ainvr_ai_service')  # the unit's ExecStart path


def install_ai(binary, backup):
    # An AI service that still budgets a fixed 2 GiB wedges a small memory spool
    # (ENOSPC, then ACKs fail): the binary and the mount change together.
    shutil.copy2(AI_BIN, backup / 'ainvr_ai_service.previous')
    tmp = AI_BIN.with_name(AI_BIN.name + '.next')
    shutil.copy2(binary, tmp)
    os.chmod(tmp, 0o755)
    tmp.replace(AI_BIN)


def apply(size, binary):
    owner = pwd.getpwnam('sunrise')
    if is_memory_mount():
        write_config(size, owner)
        return {'state': 'already_memory', 'size': size}
    if not binary:
        raise RuntimeError('--install-ai is required: the AI service must budget the spool by its size')
    stamp = time.strftime('%Y%m%d-%H%M%S')
    backup = ROLLBACK / stamp
    backup.mkdir(parents=True)
    stop_services()
    try:
        install_ai(binary, backup)
        old = backup / 'raw'
        RAW.rename(old)  # same filesystem: instant, keeps the SSD copy for rollback
        RAW.mkdir(mode=0o700)
        os.chown(RAW, owner.pw_uid, owner.pw_gid)
        write_config(size, owner)
        run('systemctl', 'start', mount_unit())
        if not is_memory_mount():
            raise RuntimeError('memory spool did not mount')
        copied = migrate(old, RAW, owner, captured_channels())
    except BaseException:
        if (backup / 'ainvr_ai_service.previous').exists():
            shutil.copy2(backup / 'ainvr_ai_service.previous', AI_BIN)
        if is_memory_mount():
            run('systemctl', 'stop', mount_unit(), check=False)
        remove_config()
        if (backup / 'raw').is_dir():
            if RAW.is_dir() and not any(RAW.iterdir()):
                RAW.rmdir()
            (backup / 'raw').rename(RAW)
        start_services()
        raise
    start_services()
    prune_rollbacks()
    return {'state': 'memory', 'size': size, 'ssd_copy': str(old), 'kept': copied}


def rollback():
    owner = pwd.getpwnam('sunrise')
    if not is_memory_mount():
        remove_config()
        return {'state': 'already_ssd'}
    stamp = time.strftime('%Y%m%d-%H%M%S')
    stage = ROLLBACK / ('to-ssd-' + stamp)
    stage.mkdir(parents=True)
    stop_services()
    copied = migrate(RAW, stage, owner, captured_channels())
    run('systemctl', 'stop', mount_unit())
    remove_config()
    copied['restored'] = migrate(stage, RAW, owner)['frames']
    shutil.rmtree(stage)
    start_services()
    return {'state': 'ssd', 'kept': copied}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--apply', action='store_true')
    group.add_argument('--rollback', action='store_true')
    parser.add_argument('--size', default='384m')
    parser.add_argument('--install-ai', type=Path, help='AI service binary that budgets the spool by its filesystem')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('Run as root')
    run('mountpoint', '-q', str(SSD))
    if not RAW.is_dir():
        raise RuntimeError('Review spool missing: ' + str(RAW))
    print(json.dumps(apply(args.size, args.install_ai) if args.apply else rollback(), indent=2))


if __name__ == '__main__':
    main()
