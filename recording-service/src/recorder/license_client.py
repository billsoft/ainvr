"""兼容性垫片：授权信号客户端实现位于仓库根 shared/python/license_client.py
（recorder / os-helper / restart-helper 三服务共享唯一真源），与
config_center_client.py 同款自举，保持 recorder 包内 import 路径不变。
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path


def _shared_python_dir() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "shared" / "python"
        if (candidate / "license_client.py").is_file() or (
                candidate / "license_client.pyc").is_file():
            return candidate
    raise RuntimeError(
        "找不到 shared/python/license_client.py：仓库根的共享授权客户端缺失"
    )


_shared_dir = str(_shared_python_dir())
if _shared_dir not in sys.path:
    sys.path.insert(0, _shared_dir)

_module = importlib.import_module("license_client")

LicenseSignalClient = _module.LicenseSignalClient
client_from_env = _module.client_from_env
load_env_file = _module.load_env_file

__all__ = ["LicenseSignalClient", "client_from_env", "load_env_file"]
