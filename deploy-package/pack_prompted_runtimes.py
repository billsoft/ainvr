#!/usr/bin/env python3
"""收集已验证执行器的附加依赖；CUDA/PyTorch 基础环境仍由新板部署手册准备。"""
import argparse
import json
from pathlib import Path
import py_compile
import shutil
import subprocess


def collect(repo, package):
    source = repo / 'ai-service/runtime'
    target = package / 'ai-service/runtime'
    target.mkdir(parents=True, exist_ok=True)
    for relative in ('prompted_server.py', 'resident_worker.py',
                     'locateanything/runtime.py', 'yoloe/runtime.py'):
        dest = target / (relative + 'c')
        dest.parent.mkdir(parents=True, exist_ok=True)
        py_compile.compile(str(source / relative), cfile=str(dest), dfile=relative, doraise=True)
    for name in ('locateanything', 'yoloe'):
        shutil.copy2(source / name / 'launch.sh', target / name / 'launch.sh')
        python = source / name / 'venv/bin/python'
        if not python.is_file():
            raise ValueError(f'{name}: validated runtime environment is required before packaging')
        probe = subprocess.check_output([str(python), '-c',
            'import sys,platform,json,torch; print(json.dumps(dict(prefix=sys.prefix,'
            'python=list(sys.version_info[:2]),arch=platform.machine(),torch=torch.__version__)))'], text=True)
        contract = json.loads(probe)
        if contract['python'] != [3, 10] or contract['arch'] != 'aarch64':
            raise ValueError('prompted runtime package requires the validated Jetson Python 3.10 environment')
        addons = Path(contract.pop('prefix')) / 'lib/python3.10/site-packages'
        # 不复制环境启动脚本或配置中的构建机绝对路径，也不收集数据、模型或凭据。
        for pth in addons.glob('*.pth'):
            if any(line.strip().startswith(('/', '~')) for line in pth.read_text().splitlines()):
                raise ValueError('absolute runtime dependency path: ' + pth.name)
        shutil.copytree(addons, target / name / 'dependencies',
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc'), symlinks=False)
        (target / name / 'contract.json').write_text(json.dumps(contract, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('repo', type=Path)
    parser.add_argument('package', type=Path)
    args = parser.parse_args()
    collect(args.repo, args.package)
