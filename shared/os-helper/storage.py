"""Read-only local volume discovery. Never mounts, formats, or guesses a disk.

All disk I/O is isolated in bounded child processes. System-disk siblings and
ambiguous UUIDs are not selectable; device names are display-only identities.
"""
import json
import os
import subprocess
import sys
import threading
import time

_lock = threading.Lock()
_cached = None
_expires = 0


def run_json(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=5, check=True)
    if len(result.stdout) > 512 * 1024:
        raise ValueError('存储信息超出限制')
    return json.loads(result.stdout)


def flatten(nodes):
    for node in nodes:
        yield node
        yield from flatten(node.get('children', []))


def volumes_from_tree(tree):
    volumes = []
    for disk in tree.get('blockdevices', []):
        family = list(flatten([disk]))
        system = any('/' in (n.get('mountpoints') or []) for n in family)
        for node in family:
            # Show mounted filesystems and external unmounted filesystems.
            mounts = [m for m in node.get('mountpoints', []) if m]
            if not node.get('fstype') or (system and '/' not in mounts):
                continue
            uuid = node.get('uuid') or ''
            mount = '/' if system else next((m for m in mounts if m.startswith(('/mnt/', '/media/', '/run/media/'))), '')
            readonly = bool(node.get('ro'))
            volumes.append(dict(id=uuid, device=node['path'], label=node.get('label') or node['name'],
                transport=node.get('tran') or disk.get('tran') or 'local', filesystem=node['fstype'],
                mountPath=mount, system=system, readOnly=readonly,
                totalBytes=int(node.get('size') or 0), availableBytes=None,
                selectable=bool(uuid and mount and not readonly and not system),
                state='system' if system else 'mounted' if mount else 'unmounted'))
    for volume in volumes:
        if sum(v['id'] == volume['id'] for v in volumes) > 1:
            volume['selectable'] = False
            volume['state'] = 'ambiguous'
    return volumes


def inventory():
    global _cached, _expires
    with _lock:
        if _cached is not None and time.monotonic() < _expires:
            return _cached
        tree = run_json(['lsblk', '-J', '-b', '-o', 'NAME,PATH,TYPE,TRAN,SIZE,FSTYPE,UUID,LABEL,MOUNTPOINTS,RO'])
        volumes = volumes_from_tree(tree)
        # One child, one overall timeout, even if a USB device stalls statvfs.
        paths = [v['mountPath'] for v in volumes if v['mountPath']]
        try:
            usage = run_json([sys.executable, '-c',
                'import os,json,sys; r={};\nfor p in json.loads(sys.argv[1]):\n try:\n  s=os.statvfs(p); r[p]=[s.f_blocks*s.f_frsize,s.f_bavail*s.f_frsize]\n except OSError: pass\nprint(json.dumps(r))', json.dumps(paths)])
        except (subprocess.SubprocessError, ValueError):
            usage = {}
        for volume in volumes:
            if volume['mountPath'] in usage:
                volume['totalBytes'], volume['availableBytes'] = usage[volume['mountPath']]
            elif volume['mountPath']:
                volume['selectable'] = False
                volume['state'] = 'unavailable'
        _cached = dict(volumes=volumes, sampledAt=int(time.time() * 1000))
        _expires = time.monotonic() + 10
        return _cached


def safe_directory(root, relative):
    """Open without following any symlink, including races on intermediate nodes."""
    if len(relative) > 1024 or relative.startswith('/'):
        raise ValueError('目录必须位于选定磁盘内')
    parts = relative.split('/') if relative else []
    if any(p in ('', '.', '..') for p in parts):
        raise ValueError('目录不合法')
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    device = os.fstat(fd).st_dev
    try:
        if device == os.stat('/').st_dev:
            raise ValueError('外置磁盘已离线，不能回落到系统盘')
        for part in parts:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            if os.fstat(fd).st_dev != device:
                raise ValueError('不能跨越到其他挂载点')
        names = []
        truncated = False
        with os.scandir(fd) as entries:
            for scanned, entry in enumerate(entries):
                if scanned >= 2000:
                    truncated = True
                    break
                if entry.name.startswith('.') or not entry.is_dir(follow_symlinks=False):
                    continue
                if len(names) == 200:
                    truncated = True
                    break
                names.append(entry.name)
        return dict(directories=sorted(names), truncated=truncated)
    finally:
        os.close(fd)


def browse(uuid, relative):
    volume = next((v for v in inventory()['volumes'] if v['id'] == uuid and v['selectable']), None)
    if not volume:
        raise ValueError('磁盘未挂载、只读或不可选，请刷新后重试')
    return run_json([sys.executable, __file__, volume['mountPath'], relative])


if __name__ == '__main__':
    print(json.dumps(safe_directory(sys.argv[1], sys.argv[2])))
