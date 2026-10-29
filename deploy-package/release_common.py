"""Read-only artifact verification shared by supported release tools."""
import hashlib,json,time,urllib.request,os,stat,shutil,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024*1024), b''):
            digest.update(block)
    return digest.hexdigest()


def files(folder):
    if folder.is_symlink() or not folder.is_dir():
        raise ValueError('Expected a real artifact directory')
    result = {}
    for p in sorted(folder.rglob('*')):
        if p.is_symlink():
            raise ValueError('Artifact symlinks are not allowed')
        if p.is_file():
            result[str(p.relative_to(folder))] = sha(p)
    return result


def relative(name):
    value = Path(name)
    if value.is_absolute() or '..' in value.parts or not value.parts:
        raise ValueError('Manifest path escapes its root')
    return value


def validate(candidate):
    candidate = candidate.resolve(strict=True)
    if not candidate.is_relative_to(ROOT/'out'):
        raise ValueError('Candidate must be below the current repository out directory')
    if json.loads((candidate/'status.json').read_text()).get('phase') != 'built':
        raise ValueError('Console build did not finish')
    sources = json.loads((candidate/'source-manifest.json').read_text())
    if not sources:
        raise ValueError('Empty source manifest')
    for name, want in sources.items():
        path = ROOT/relative(name)
        if not path.resolve(strict=True).is_relative_to(ROOT) or sha(path) != want:
            raise ValueError('Console source generation changed: '+name)
    artifacts = json.loads((candidate/'artifacts.json').read_text())
    for name in ['frontend', 'backend']:
        expected = artifacts[name]
        for path in expected:
            relative(path)
        if not expected or files(candidate/name) != expected:
            raise ValueError('Console artifact manifest mismatch: '+name)
    if not (candidate/'backend/server.js').is_file() or not (candidate/'frontend/index.html').is_file():
        raise ValueError('Console entrypoints missing')
    return candidate


def ready():
    deadline = time.monotonic()+40
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen('http://127.0.0.1:3001/api/health', timeout=3) as response:
                data = json.load(response)
            if data.get('data', {}).get('status') == 'ok':
                return
        except (OSError, ValueError):
            pass
        time.sleep(.5)
    raise RuntimeError('Console backend did not become ready')


def atomic_bytes(path, data, mode=0o600, owner=None):
    """Bounded managed-file replacement, shared by release profiles."""
    path=Path(path)
    if path.is_symlink():
        raise ValueError('Managed destination must not be a symlink')
    path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_name(path.name+'.release-'+uuid.uuid4().hex)
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
    try:
        with os.fdopen(fd,'wb') as stream:
            stream.write(data);stream.flush();os.fsync(stream.fileno())
        if owner is not None:os.chown(temp,*owner)
        os.chmod(temp,mode);os.replace(temp,path)
        directory=os.open(path.parent,os.O_DIRECTORY)
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:
        if temp.exists():temp.unlink()


def snapshot_files(paths, backup, permitted_root):
    """Save explicit files only; no recursive state/config directory copying.

    Unit symlinks may target this repository, and both link and target bytes are
    captured. A restore therefore does not depend on an old eMMC release tree.
    """
    backup=Path(backup);backup.mkdir(parents=True,exist_ok=True)
    result={}
    for index,path in enumerate(dict.fromkeys(map(Path,paths))):
        record={'exists':path.exists() or path.is_symlink()}
        if not record['exists']:result[str(path)]=record;continue
        st=path.lstat();record.update(mode=stat.S_IMODE(st.st_mode),uid=st.st_uid,gid=st.st_gid)
        source=path
        if path.is_symlink():
            source=path.resolve(strict=True)
            if not source.is_relative_to(permitted_root) or source.is_symlink():raise ValueError('Unexpected managed file symlink')
            record.update(link=os.readlink(path),target=str(source),target_mode=stat.S_IMODE(source.stat().st_mode),target_uid=source.stat().st_uid,target_gid=source.stat().st_gid)
        if not source.is_file():raise ValueError('Expected a regular managed file')
        name=str(index)+'.bin';target=backup/name
        # Backups are the only rollback authority; make bytes durable before
        # publishing the transaction record that refers to them.
        atomic_bytes(target,source.read_bytes(),0o600)
        record.update(content=name,sha256=sha(target));result[str(path)]=record
    return result


def restore_files(records, backup, allowed_paths, permitted_root):
    """Restore only a profile's explicit allowlist, after integrity preflight."""
    allowed={str(Path(path)) for path in allowed_paths}
    if set(records)!=allowed:raise ValueError('Managed restore file set changed')
    for name,record in records.items():
        path=Path(name)
        if not record['exists']:
            if path.exists() or path.is_symlink():
                if path.is_dir() and not path.is_symlink():raise ValueError('Unexpected managed directory')
                path.unlink()
            continue
        content=Path(backup)/relative(record['content'])
        if content.is_symlink() or sha(content)!=record['sha256']:raise ValueError('Managed backup changed')
        if record.get('link'):
            target=Path(record['target'])
            if not target.is_relative_to(permitted_root):raise ValueError('Managed link target escapes repository')
            atomic_bytes(target,content.read_bytes(),record['target_mode'],(record['target_uid'],record['target_gid']))
            if path.exists() or path.is_symlink():path.unlink()
            path.parent.mkdir(parents=True,exist_ok=True);path.symlink_to(record['link'])
            os.lchown(path,record['uid'],record['gid'])
        else:
            if path.is_symlink():path.unlink()
            atomic_bytes(path,content.read_bytes(),record['mode'],(record['uid'],record['gid']))
