"""让 tests/ 下的用例直接 import 上层目录的 license_client / config_center_client。"""
import sys
from pathlib import Path

_PARENT = str(Path(__file__).resolve().parent.parent)
if _PARENT not in sys.path:
    sys.path.insert(0, _PARENT)
