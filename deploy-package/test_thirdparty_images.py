"""thirdparty_images.py 单测：清单解析、镜像 ID 校验、compose 核对。"""
import subprocess

import pytest

import thirdparty_images as ti

SRS_ID = 'sha256:' + 'b' * 64


def write(tmp_path, text):
    p = tmp_path / 'images.txt'
    p.write_text(text, encoding='utf-8')
    return p


def test_load_skips_comments_and_parses_unpinned(tmp_path):
    p = write(tmp_path, f'# c\n\npostgres:16-alpine -\nossrs/srs:7.0.162 {SRS_ID}\n')
    assert ti.load(p) == [('postgres:16-alpine', None), ('ossrs/srs:7.0.162', SRS_ID)]


@pytest.mark.parametrize('line', ['ossrs/srs:7.0.162', 'ossrs/srs:7.0.162 sha256:xyz', 'a b c'])
def test_load_rejects_malformed_lines(tmp_path, line):
    with pytest.raises(ValueError):
        ti.load(write(tmp_path, line + '\n'))


def test_srs_ref_requires_exactly_one():
    assert ti.srs_ref([('ossrs/srs:7.0.162', None)]) == 'ossrs/srs:7.0.162'
    with pytest.raises(ValueError):
        ti.srs_ref([('mongo:7.0', None)])
    with pytest.raises(ValueError):
        ti.srs_ref([('ossrs/srs:6.0.191', None), ('ossrs/srs:7.0.162', None)])


def fake_run(ids):
    def run(argv, **_):
        ref = argv[-1]
        if ref in ids:
            return subprocess.CompletedProcess(argv, 0, ids[ref] + '\n', '')
        return subprocess.CompletedProcess(argv, 1, '', 'No such image')
    return run


def test_verify_reports_missing_and_mismatched_only_for_pinned():
    entries = [('mongo:7.0', None), ('ossrs/srs:7.0.162', SRS_ID)]
    assert ti.verify(entries, fake_run({'ossrs/srs:7.0.162': SRS_ID})) == []
    assert '本机没有' in ti.verify(entries, fake_run({}))[0]
    assert '不一致' in ti.verify(entries, fake_run({'ossrs/srs:7.0.162': 'sha256:' + 'c' * 64}))[0]


def test_compose_srs_image_reads_only_srs_service():
    text = ('services:\n  mongo:\n    image: mongo:7.0\n'
            '  srs:\n    logging: x\n    image: ossrs/srs:7.0.162\n    container_name: ainvr-srs\n'
            '  backend:\n    image: other\n')
    assert ti.compose_srs_image(text) == 'ossrs/srs:7.0.162'
    assert ti.compose_srs_image('services:\n  mongo:\n    image: mongo:7.0\n') is None


def test_repo_manifest_matches_repo_compose():
    # 仓库里的清单与 compose 必须一致（防止只改一处）
    from pathlib import Path
    root = Path(__file__).resolve().parent
    entries = ti.load(root / 'thirdparty-images.txt')
    compose = (root.parent / 'srs-web-console' / 'docker-compose.yml').read_text(encoding='utf-8')
    assert ti.compose_srs_image(compose) == ti.srs_ref(entries)


# ---- ensure_ffmpeg8：录像 H.265 读端属于录像组件，任何安装入口（含 --only python）都要补齐 ----

class FakeDocker:
    """模拟 docker：记录调用；images 为 引用→ID；load 后按 tar_images 补进 images。"""

    def __init__(self, images=None, tar_images=None, pull_images=None, binary=b'ffmpeg-8.1.2'):
        self.images = dict(images or {})
        self.tar_images = dict(tar_images or {})
        self.pull_images = dict(pull_images or {})
        self.binary = binary
        self.calls = []

    def __call__(self, argv, **_):
        self.calls.append(argv[:3])
        ok = lambda out='': subprocess.CompletedProcess(argv, 0, out, '')  # noqa: E731
        fail = subprocess.CompletedProcess(argv, 1, '', 'error')
        if argv[:3] == ['docker', 'image', 'inspect']:
            ref = argv[-1]
            return ok(self.images[ref] + '\n') if ref in self.images else fail
        if argv[:2] == ['docker', 'load']:
            self.images.update(self.tar_images)
            return ok('Loaded')
        if argv[:2] == ['docker', 'pull']:
            if argv[2] in self.pull_images:
                self.images[argv[2]] = self.pull_images[argv[2]]
                return ok()
            return fail
        if argv[:2] == ['docker', 'create']:
            return ok('cid123\n') if argv[2] in self.images else fail
        if argv[:2] == ['docker', 'cp']:
            from pathlib import Path
            Path(argv[3]).write_bytes(self.binary)
            return ok()
        if argv[:2] == ['docker', 'rm']:
            return ok()
        raise AssertionError(argv)


def sha(b):
    import hashlib
    return hashlib.sha256(b).hexdigest()


SRS = 'ossrs/srs:7.0.162'
ENTRIES = [('mongo:7.0', None), (SRS, SRS_ID)]


def test_ffmpeg8_already_installed_and_intact_is_left_alone(tmp_path):
    dest = tmp_path / 'ffmpeg-8.1.2'
    (dest / 'bin').mkdir(parents=True)
    (dest / 'bin' / 'ffmpeg').write_bytes(b'ffmpeg-8.1.2')
    docker = FakeDocker()
    msg = ti.ensure_ffmpeg8(ENTRIES, dest, None, run=docker, expected_sha=sha(b'ffmpeg-8.1.2'))
    assert '已就绪' in msg and docker.calls == []


def test_ffmpeg8_extracted_from_the_pinned_local_srs_image(tmp_path):
    dest = tmp_path / 'ffmpeg-8.1.2'
    docker = FakeDocker(images={SRS: SRS_ID})
    ti.ensure_ffmpeg8(ENTRIES, dest, None, run=docker, expected_sha=sha(b'ffmpeg-8.1.2'))
    exe = dest / 'bin' / 'ffmpeg'
    assert exe.read_bytes() == b'ffmpeg-8.1.2'
    assert (dest / 'SHA256SUMS').read_text() == f'{sha(b"ffmpeg-8.1.2")}  bin/ffmpeg\n'
    import os
    if os.name != 'nt':
        assert os.stat(exe).st_mode & 0o111
    assert ['docker', 'load'] not in [c[:2] for c in docker.calls]


def test_ffmpeg8_on_an_old_board_loads_the_offline_srs_image_first(tmp_path):
    # 旧板只更新录像服务：本机还是 SRS 6，发布包里带着离线镜像 → 先 load 再提取
    tar = tmp_path / 'thirdparty.tar'
    tar.write_bytes(b'x')
    dest = tmp_path / 'ffmpeg-8.1.2'
    docker = FakeDocker(images={'ossrs/srs:6.0.191': 'sha256:' + 'a' * 64}, tar_images={SRS: SRS_ID})
    ti.ensure_ffmpeg8(ENTRIES, dest, tar, run=docker, expected_sha=sha(b'ffmpeg-8.1.2'))
    assert (dest / 'bin' / 'ffmpeg').exists()
    assert ['docker', 'load', '-i'] in docker.calls


def test_ffmpeg8_without_offline_tar_pulls_the_pinned_image(tmp_path):
    dest = tmp_path / 'ffmpeg-8.1.2'
    docker = FakeDocker(pull_images={SRS: SRS_ID})
    ti.ensure_ffmpeg8(ENTRIES, dest, tmp_path / 'missing.tar', run=docker, expected_sha=sha(b'ffmpeg-8.1.2'))
    assert (dest / 'bin' / 'ffmpeg').exists()


def test_ffmpeg8_refuses_an_srs_image_whose_id_differs_from_the_manifest(tmp_path):
    dest = tmp_path / 'ffmpeg-8.1.2'
    docker = FakeDocker(images={SRS: 'sha256:' + 'c' * 64})
    with pytest.raises(RuntimeError, match='镜像 ID'):
        ti.ensure_ffmpeg8(ENTRIES, dest, None, run=docker, expected_sha=sha(b'ffmpeg-8.1.2'))
    assert not dest.exists()


def test_ffmpeg8_checksum_mismatch_installs_nothing(tmp_path):
    dest = tmp_path / 'ffmpeg-8.1.2'
    docker = FakeDocker(images={SRS: SRS_ID}, binary=b'tampered')
    with pytest.raises(RuntimeError, match='校验'):
        ti.ensure_ffmpeg8(ENTRIES, dest, None, run=docker, expected_sha=sha(b'ffmpeg-8.1.2'))
    assert not (dest / 'bin' / 'ffmpeg').exists()


def test_ffmpeg8_damaged_existing_binary_is_replaced(tmp_path):
    dest = tmp_path / 'ffmpeg-8.1.2'
    (dest / 'bin').mkdir(parents=True)
    (dest / 'bin' / 'ffmpeg').write_bytes(b'half-written')
    docker = FakeDocker(images={SRS: SRS_ID})
    ti.ensure_ffmpeg8(ENTRIES, dest, None, run=docker, expected_sha=sha(b'ffmpeg-8.1.2'))
    assert (dest / 'bin' / 'ffmpeg').read_bytes() == b'ffmpeg-8.1.2'


def test_ffmpeg8_no_image_anywhere_is_an_explicit_error(tmp_path):
    with pytest.raises(RuntimeError, match='--only console|thirdparty'):
        ti.ensure_ffmpeg8(ENTRIES, tmp_path / 'f', None, run=FakeDocker(), expected_sha=sha(b'x'))
