"""Read-only artifact verification shared by supported release tools."""
import hashlib,json,time,urllib.request
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
