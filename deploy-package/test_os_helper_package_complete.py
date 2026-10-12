"""系统助手的每个模块都必须进离线包，并在安装校验清单里。

build-release.sh 按文件名逐个拷贝 os-helper 模块：新增模块（如 2026-10-09 的 systime.py）
忘了加，开发板上一切正常，离线包装出来的设备系统助手却会因缺模块启动失败。
"""
from pathlib import Path
import re
import unittest

HERE = Path(__file__).resolve().parent
OS_HELPER = HERE.parent / 'shared' / 'os-helper'


def modules():
    return {p.name for p in OS_HELPER.glob('*.py')}


class OsHelperPackageCompleteTest(unittest.TestCase):
    def test_build_release_copies_every_module(self):
        text = (HERE / 'build-release.sh').read_text(encoding='utf-8')
        copied = set(re.findall(r'shared/os-helper/([A-Za-z0-9_]+\.py)"', text))
        self.assertEqual(modules() - copied, set())

    def test_installer_requires_every_module(self):
        text = (HERE / 'install_python_code.py').read_text(encoding='utf-8')
        required = set(re.findall(r"'shared/os-helper/([A-Za-z0-9_]+)\.pyc'", text))
        self.assertEqual({m[:-3] for m in modules()} - required, set())


if __name__ == '__main__':
    unittest.main()
