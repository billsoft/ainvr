#!/usr/bin/env python3
"""公共镜像清单工具：列出引用、校验镜像 ID、核对 compose 里的 SRS 镜像。

  thirdparty_images.py refs   <清单>                 # 每行一个镜像引用
  thirdparty_images.py srs    <清单>                 # 输出 SRS 镜像引用
  thirdparty_images.py verify <清单>                 # 本机镜像 ID 与清单一致，否则非 0 退出
  thirdparty_images.py compose <清单> <compose.yml>  # compose 的 srs 服务镜像与清单一致
  thirdparty_images.py ffmpeg8 <清单> <目标目录> [离线 thirdparty.tar]
                                                     # 确保录像 H.265 读端 FFmpeg 8.1.2 就绪
"""
import hashlib
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

# 录像 H.265 读端：SRS 7.0.162 镜像自带的 FFmpeg 8.1.2（许可已确认），只从已校验 ID 的
# SRS 镜像里取，不另行下载。设计 docs/h265-codec12-support-design-2026-09-29.md §7。
FFMPEG8_IN_IMAGE = '/usr/local/srs/objs/ffmpeg/bin/ffmpeg'
FFMPEG8_SHA256 = 'df17651e39409852970c249474044649c9f9663b020b5b93b72650f45a5a9da8'


def load(path):
    entries = []
    for raw in Path(path).read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        parts = line.split()
        if len(parts) != 2:
            raise ValueError(f'清单行格式错误：{raw!r}')
        ref, image_id = parts
        if image_id != '-' and not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id):
            raise ValueError(f'镜像 ID 格式错误：{raw!r}')
        entries.append((ref, None if image_id == '-' else image_id))
    return entries


def srs_ref(entries):
    refs = [ref for ref, _ in entries if ref.startswith('ossrs/srs:')]
    if len(refs) != 1:
        raise ValueError('清单里必须恰好有一个 ossrs/srs 镜像')
    return refs[0]


def local_image_id(ref, run=subprocess.run):
    result = run(['docker', 'image', 'inspect', '--format', '{{.Id}}', ref],
                 capture_output=True, text=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else None


def verify(entries, run=subprocess.run):
    problems = []
    for ref, expected in entries:
        if expected is None:
            continue
        actual = local_image_id(ref, run)
        if actual is None:
            problems.append(f'{ref}：本机没有该镜像')
        elif actual != expected:
            problems.append(f'{ref}：镜像 ID {actual} 与清单 {expected} 不一致')
    return problems


def compose_srs_image(text):
    # 只看 services.srs 下的 image 行：services 下两格缩进的服务名、四格缩进的键
    in_srs = False
    for line in text.splitlines():
        if re.match(r'^  [A-Za-z0-9_-]+:\s*$', line):
            in_srs = line.strip() == 'srs:'
            continue
        m = re.match(r'^    image:\s*(\S+)', line)
        if in_srs and m:
            return m.group(1)
    return None


def _sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def _pinned_srs(entries):
    ref = srs_ref(entries)
    expected = dict(entries)[ref]
    if expected is None:
        raise ValueError(f'{ref} 没有锁定镜像 ID，不能从它提取 FFmpeg')
    return ref, expected


def _obtain_srs_image(ref, expected, tar, run):
    """本机没有清单里那个 SRS 镜像时：先离线 load，再联网 pull。ID 不符一律拒绝。"""
    actual = local_image_id(ref, run)
    if actual is None and tar is not None and Path(tar).is_file():
        run(['docker', 'load', '-i', str(tar)], capture_output=True, text=True, check=False)
        actual = local_image_id(ref, run)
    if actual is None:
        run(['docker', 'pull', ref], capture_output=True, text=True, check=False)
        actual = local_image_id(ref, run)
    if actual is None:
        raise RuntimeError(f'本机没有 {ref}，发布包也没有离线镜像（thirdparty.tar）且无法联网拉取；'
                           '请用 build-release.sh --with-thirdparty 出包，或先执行 install.sh --only console')
    if actual != expected:
        raise RuntimeError(f'{ref} 的镜像 ID {actual} 与清单 {expected} 不一致，拒绝从中提取 FFmpeg')


def ensure_ffmpeg8(entries, dest, tar=None, run=subprocess.run, expected_sha=FFMPEG8_SHA256):
    """确保 <dest>/bin/ffmpeg 是校验过的 FFmpeg 8.1.2。已就绪不动；缺失或损坏则从 SRS 镜像提取。

    幂等：录像组件的每个安装入口都调用它，完整安装和 --only python 行为一致。
    提取失败时不留下半成品（先写临时文件、校验通过再原子替换）。
    """
    dest = Path(dest)
    exe = dest / 'bin' / 'ffmpeg'
    if exe.is_file() and _sha256(exe) == expected_sha:
        return f'FFmpeg 8.1.2 已就绪：{exe}'
    ref, expected_id = _pinned_srs(entries)
    _obtain_srs_image(ref, expected_id, tar, run)
    created = run(['docker', 'create', ref], capture_output=True, text=True, check=False)
    if created.returncode != 0:
        raise RuntimeError(f'无法从 {ref} 创建临时容器：{created.stderr.strip()}')
    cid = created.stdout.strip()
    with tempfile.TemporaryDirectory() as tmp:
        staged = Path(tmp) / 'ffmpeg'
        try:
            cp = run(['docker', 'cp', f'{cid}:{FFMPEG8_IN_IMAGE}', str(staged)],
                     capture_output=True, text=True, check=False)
        finally:
            run(['docker', 'rm', cid], capture_output=True, text=True, check=False)
        if cp.returncode != 0 or not staged.is_file():
            raise RuntimeError(f'{ref} 里没有 {FFMPEG8_IN_IMAGE}')
        actual_sha = _sha256(staged)
        if actual_sha != expected_sha:
            raise RuntimeError(f'FFmpeg 8.1.2 校验失败：{actual_sha} ≠ {expected_sha}（SRS 镜像内容与预期不符）')
        (dest / 'bin').mkdir(parents=True, exist_ok=True)
        part = exe.with_name('ffmpeg.part')
        part.write_bytes(staged.read_bytes())
        os.chmod(part, 0o755)
        os.replace(part, exe)
    (dest / 'SHA256SUMS').write_text(f'{expected_sha}  bin/ffmpeg\n', encoding='utf-8')
    return f'FFmpeg 8.1.2 已从 {ref} 提取到 {exe}'


def main(argv):
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    cmd, manifest = argv[1], argv[2]
    try:
        entries = load(manifest)
        if cmd == 'refs':
            print('\n'.join(ref for ref, _ in entries))
        elif cmd == 'srs':
            print(srs_ref(entries))
        elif cmd == 'verify':
            problems = verify(entries)
            if problems:
                print('\n'.join(problems), file=sys.stderr)
                return 1
            print('公共镜像 ID 校验通过')
        elif cmd == 'ffmpeg8':
            print(ensure_ffmpeg8(entries, argv[3], argv[4] if len(argv) > 4 else None))
        elif cmd == 'compose':
            image = compose_srs_image(Path(argv[3]).read_text(encoding='utf-8'))
            expected = srs_ref(entries)
            if image != expected:
                print(f'compose 的 srs 镜像 {image} 与清单 {expected} 不一致', file=sys.stderr)
                return 1
            print(f'compose 的 srs 镜像与清单一致：{expected}')
        else:
            print(__doc__, file=sys.stderr)
            return 2
    except (OSError, ValueError, IndexError, RuntimeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
