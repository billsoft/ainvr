"""兼容性垫片（2026-09-16 评审收口）。

实现已上移到仓库根 shared/python/config_center_client.py——AI 与录像两个
微服务共享的唯一真源，历史上的双份手工同步拷贝已删除。本文件只负责定位
shared/python 并转出公共符号，保持原有 import 路径
（`from recorder.config_center_client import ...` /
`from .config_center_client import ...`）与测试不变；systemd unit 也无需
额外配置 PYTHONPATH。

垫片向上逐级查找含 shared/python/config_center_client.py（或其编译产物
.pyc，无源码制品部署形态）的目录，
因此无论从仓库工作树还是打包后的同级布局启动都能找到。
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path


def _shared_python_dir() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "shared" / "python"
        if (candidate / "config_center_client.py").is_file() or (
                candidate / "config_center_client.pyc").is_file():
            return candidate
    raise RuntimeError(
        "找不到 shared/python/config_center_client.py：仓库根的共享客户端缺失"
    )


_shared_dir = str(_shared_python_dir())
if _shared_dir not in sys.path:
    sys.path.insert(0, _shared_dir)

_module = importlib.import_module("config_center_client")

ConfigCenterClient = _module.ConfigCenterClient
client_from_env = _module.client_from_env
service_token_env_name = _module.service_token_env_name

__all__ = ["ConfigCenterClient", "client_from_env", "service_token_env_name"]
