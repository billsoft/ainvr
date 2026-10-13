#!/usr/bin/env python3
"""Read-only OE GPU environment check, not a model or performance test."""
import importlib.metadata as m
import json
import platform
import subprocess

expected = {'horizon-tc-ui': '3.5.3', 'hbdk4-compiler': '4.7.5',
            'hmct-gpu': '2.6.5+cu126', 'onnxruntime-gpu': '1.19.0'}
actual = {name: m.version(name) for name in expected}
assert platform.machine() in ('x86_64', 'AMD64'), 'Compiler host must be x86_64'
assert actual == expected, (actual, expected)
from hmct.executor.ort2 import ORTExecutor2
import onnxruntime as ort
assert ORTExecutor2.get_support_devices()[0] == 'cuda'
assert 'CUDAExecutionProvider' in ort.get_available_providers()
gpu = subprocess.check_output(['nvidia-smi', '--query-gpu=name,memory.total,memory.free',
                               '--format=csv,noheader'], text=True).strip()
print(json.dumps({'versions': actual, 'python': platform.python_version(), 'gpu': gpu,
                  'environment_passed': True, 'actual_cuda_model_execution_tested': False}, indent=2))
