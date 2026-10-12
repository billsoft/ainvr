#!/usr/bin/env python3
"""Copyright AINVR. Fetch verified ARM64 Docker archives from Docker Hub.

Run on an internet-connected staging host when the board cannot reach Hub.
Every manifest, configuration and compressed/uncompressed layer is checked
against the SHA256 advertised by the official upstream registry.
"""
from concurrent.futures import ThreadPoolExecutor
import gzip
import hashlib
import io
import json
from pathlib import Path
import shutil
import tarfile
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent / 'offline-images'
ROOT.mkdir(exist_ok=True)
ACCEPT = ','.join(('application/vnd.oci.image.index.v1+json',
                   'application/vnd.docker.distribution.manifest.list.v2+json',
                   'application/vnd.oci.image.manifest.v1+json',
                   'application/vnd.docker.distribution.manifest.v2+json'))
IMAGES = [('ossrs/srs', '7.0.162'), ('library/postgres', '16-alpine'),
          ('library/mongo', '7.0')]


def digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def fetch(url, headers=None):
    last_error = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}),
                                        timeout=60) as response:
                return response.read()
        except OSError as error:
            last_error = error
            if attempt == 0:
                time.sleep(2)
    raise last_error


def add_bytes(archive, name, content):
    info = tarfile.TarInfo(name)
    info.size = len(content)
    info.mode = 0o644
    archive.addfile(info, io.BytesIO(content))


def build_image(repository, tag):
    name = repository.replace('/', '-') + '-' + tag
    existing_record = ROOT / (name + '.provenance.json')
    if existing_record.exists():
        record = json.loads(existing_record.read_text())
        path = ROOT / record['archive']
        with path.open('rb') as file:
            actual = hashlib.file_digest(file, 'sha256').hexdigest()
        if actual == record['archive_sha256']:
            print('Reusing verified archive', path.name, flush=True)
            return record
    token_url = 'https://auth.docker.io/token?' + urllib.parse.urlencode({
        'service': 'registry.docker.io', 'scope': f'repository:{repository}:pull'})
    token = json.loads(fetch(token_url))['token']
    headers = {'Authorization': 'Bearer ' + token, 'Accept': ACCEPT}
    base = 'https://registry-1.docker.io/v2/' + repository
    index_raw = fetch(base + '/manifests/' + tag, headers)
    index = json.loads(index_raw)
    selected = next(m for m in index['manifests']
                    if m.get('platform', {}).get('architecture') == 'arm64'
                    and m['platform']['os'] == 'linux')
    manifest_raw = fetch(base + '/manifests/' + selected['digest'], headers)
    assert digest(manifest_raw) == selected['digest']
    manifest = json.loads(manifest_raw)
    config_raw = fetch(base + '/blobs/' + manifest['config']['digest'], headers)
    assert digest(config_raw) == manifest['config']['digest']
    config = json.loads(config_raw)
    assert config['architecture'] == 'arm64' and config['os'] == 'linux'
    cache = ROOT / 'blobs'
    cache.mkdir(exist_ok=True)
    tag_ref = repository.removeprefix('library/') + ':' + tag
    print('Fetching', tag_ref, 'linux/arm64', selected['digest'], flush=True)

    def layer_fetch(layer):
        path = cache / layer['digest'].split(':')[1]
        if path.exists() and digest(path.read_bytes()) == layer['digest']:
            return path
        print('Fetching missing layer', layer['digest'], flush=True)
        content = fetch(base + '/blobs/' + layer['digest'], headers)
        assert digest(content) == layer['digest'], 'Layer digest mismatch'
        temp = path.with_suffix('.partial')
        temp.write_bytes(content)
        temp.replace(path)
        print('Verified layer', layer['digest'], len(content), flush=True)
        return path

    # Serialize transfers on staging networks that limit concurrent TLS flows.
    with ThreadPoolExecutor(max_workers=1) as pool:
        paths = list(pool.map(layer_fetch, manifest['layers']))
    archive_path = ROOT / (name + '.tar.gz')
    diff_ids = config['rootfs']['diff_ids']
    entries = []
    with tarfile.open(archive_path, 'w:gz', compresslevel=1) as archive:
        config_name = manifest['config']['digest'].split(':')[1] + '.json'
        add_bytes(archive, config_name, config_raw)
        for i, (layer, path) in enumerate(zip(manifest['layers'], paths)):
            unpacked = ROOT / (name + '-layer.tmp')
            opener = gzip.open if 'gzip' in layer['mediaType'] else open
            with opener(path, 'rb') as source, unpacked.open('wb') as target:
                shutil.copyfileobj(source, target, 1024 * 1024)
            actual = hashlib.file_digest(unpacked.open('rb'), 'sha256').hexdigest()
            assert 'sha256:' + actual == diff_ids[i], 'Uncompressed layer digest mismatch'
            entry = actual + '/layer.tar'
            archive.add(unpacked, arcname=entry, recursive=False)
            entries.append(entry)
            unpacked.unlink()
        add_bytes(archive, 'manifest.json', json.dumps([{
            'Config': config_name, 'RepoTags': [tag_ref], 'Layers': entries}]).encode())
    result = {'image': tag_ref, 'platform': 'linux/arm64',
              'source': 'https://registry-1.docker.io',
              'index_digest': digest(index_raw), 'manifest_digest': selected['digest'],
              'image_id': manifest['config']['digest'],
              'archive': archive_path.name,
              'archive_sha256': hashlib.file_digest(archive_path.open('rb'), 'sha256').hexdigest()}
    (ROOT / (name + '.provenance.json')).write_text(json.dumps(result, indent=2) + '\n')
    print('Archive ready', archive_path.name, archive_path.stat().st_size, flush=True)
    return result


if __name__ == '__main__':
    records = [build_image(repository, tag) for repository, tag in IMAGES]
    (ROOT / 'images.lock.json').write_text(json.dumps(records, indent=2) + '\n')
