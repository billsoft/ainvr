#!/usr/bin/env python3
"""AINVR model contract validation. No model family is inferred from filenames."""
import argparse
import json
from pathlib import Path

def validate(contract):
    if contract.get('schema_version') != 1:
        raise ValueError('schema_version must be 1')
    if contract.get('target') != 'nash-m':
        raise ValueError('RDK S100P requires target nash-m')
    if contract.get('provider') != 'bpu':
        raise ValueError('Only the native bpu provider is supported')
    if not str(contract.get('model', '')).endswith('.hbm'):
        raise ValueError('Compiled .hbm model required; TensorRT engines are not portable')
    if contract.get('input_format') not in ('nv12', 'rgb', 'bgr', 'tensor'):
        raise ValueError('Explicit input_format required')
    if not contract.get('inputs') or not contract.get('outputs'):
        raise ValueError('Named input and output contracts required')
    for kind in ('inputs', 'outputs'):
        seen=set()
        for tensor in contract[kind]:
            name=tensor.get('name')
            if not isinstance(name,str) or not name or name in seen:
                raise ValueError('Tensor names must be nonempty and unique')
            seen.add(name)
            shape=tensor.get('shape')
            if not isinstance(shape,list) or not shape or any(type(d) is not int or d<=0 for d in shape):
                raise ValueError('Static positive shapes required')
            if tensor.get('dtype') not in ('uint8','int8','int16','int32','float16','float32'):
                raise ValueError('Unsupported tensor dtype')
    if not contract.get('postprocess'):
        raise ValueError('Model-specific postprocess contract required')
    return contract

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    args=parser.parse_args()
    validate(json.loads(args.manifest.read_text(encoding='utf-8')))
    print('Model contract valid (does not prove HBM compatibility or accuracy)')

if __name__=='__main__':main()
