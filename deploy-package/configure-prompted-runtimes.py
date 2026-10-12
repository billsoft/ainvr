#!/usr/bin/env python3
"""离线安装执行器附加依赖和服务；不联网下载、不带入构建板的环境配置。"""
import argparse
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess


def install(package, root, base_python):
    if os.geteuid() != 0:
        raise PermissionError('run as root')
    user = pwd.getpwnam('ainvr')
    source = package / 'ai-service/runtime'
    if not source.is_dir():
        raise ValueError('release is missing prompted runtimes')
    subprocess.run(['systemctl', 'stop', 'ainvr-yoloe', 'ainvr-grounding'], check=False)
    target = root / 'runtime'
    target.mkdir(parents=True, exist_ok=True)
    for name in ('prompted_server.pyc', 'resident_worker.pyc'):
        (target / name[:-1]).unlink(missing_ok=True)
        shutil.copy2(source / name, target / name)
    configuration = Path('/etc/ainvr-ai')
    configuration.mkdir(mode=0o750, parents=True, exist_ok=True)
    for name, service in (('yoloe', 'ainvr-yoloe'), ('locateanything', 'ainvr-grounding')):
        dest = target / name
        dest.mkdir(exist_ok=True)
        for file in ('runtime.pyc', 'launch.sh'):
            if file.endswith('.pyc'):
                (dest / file[:-1]).unlink(missing_ok=True)
            shutil.copy2(source / name / file, dest / file)
        env = dest / 'venv'
        if not base_python.is_file():
            raise ValueError('prepare the documented CUDA Python environment before installing open vocabulary runtimes')
        # 基础环境由运维明确指定，附加依赖从业务包安装，不复制 venv 的绝对路径。
        subprocess.run([str(base_python), '-m', 'venv', '--system-site-packages', '--without-pip', str(env)], check=True)
        shutil.copytree(source / name / 'dependencies', env / 'lib/python3.10/site-packages', dirs_exist_ok=True)
        for path in [dest, *dest.rglob('*')]:
            if not path.is_symlink():
                os.chown(path, user.pw_uid, user.pw_gid)
        check = ('import sys,platform,json,torch; import ultralytics,clip' if name == 'yoloe'
                 else 'import sys,platform,json,torch,tensorrt,transformers')
        check += '; print(json.dumps(dict(python=list(sys.version_info[:2]),arch=platform.machine(),torch=torch.__version__)))'
        actual = json.loads(subprocess.check_output(['runuser', '-u', 'ainvr', '--', str(env / 'bin/python'), '-c', check], text=True))
        expected = json.loads((source / name / 'contract.json').read_text())
        if actual != expected:
            raise ValueError(f'{name}: base runtime differs from the validated release environment')
        if name == 'locateanything':
            values = (f'GROUNDING_PYTHON={env}/bin/python\n'
                      f'GROUNDING_MODEL={root}/models/locateanything-3b/tokenizer\n'
                      f'GROUNDING_ARTIFACTS={root}/models/locateanything-3b/trt\n')
            path = configuration / 'grounding.env'
            path.write_text(values)
            path.chmod(0o600)
        unit = (package / f'ai-service/deploy/{service}.service').read_text()
        unit = unit.replace('/home/sunrise/ainvr/ai-service', str(root))
        unit = unit.replace('/home/sunrise/ainvr', str(root.parent))
        Path(f'/etc/systemd/system/{service}.service').write_text(unit)
        subprocess.run(['systemctl', 'enable', service], check=True)
    subprocess.run(['systemctl', 'daemon-reload'], check=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('package', type=Path)
    parser.add_argument('ai_root', type=Path)
    parser.add_argument('--python', type=Path, default=Path('/home/sunrise/miniconda3/envs/ainvr/bin/python'))
    args = parser.parse_args()
    install(args.package.resolve(), args.ai_root.resolve(), args.python.resolve())
