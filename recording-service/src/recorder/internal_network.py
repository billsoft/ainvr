"""Explicit shared-policy bootstrap, independent of other module import order."""
import importlib
import sys
from pathlib import Path

for parent in Path(__file__).resolve().parents:
    candidate = parent / 'shared' / 'python'
    if any((candidate / ('internal_network' + suffix)).is_file() for suffix in ('.py', '.pyc')):
        if str(candidate) not in sys.path:
            sys.path.insert(0, str(candidate))
        break
else:
    raise RuntimeError('缺少 shared/python/internal_network 模块')

NetworkPolicy = importlib.import_module('internal_network').NetworkPolicy
