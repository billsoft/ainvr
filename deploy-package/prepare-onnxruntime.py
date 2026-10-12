#!/usr/bin/env python3
"""AINVR: stage pinned CPU ONNX Runtime SDK from an installed 1.23.2 wheel."""
from pathlib import Path
import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import os
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
VERSION='1.23.2'

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--headers',type=Path,help='Offline directory containing official v1.23.2 headers and LICENSE');args=parser.parse_args()
    assert importlib.metadata.version('onnxruntime')==VERSION,'Install the pinned ONNX Runtime wheel first'
    spec=importlib.util.find_spec('onnxruntime');source=Path(spec.origin).parent/'capi'
    destination=ROOT/'out/deps'/('onnxruntime-'+VERSION)
    contents={}
    for name in ('onnxruntime_c_api.h','onnxruntime_ep_c_api.h'):
        url=f'https://raw.githubusercontent.com/microsoft/onnxruntime/v{VERSION}/include/onnxruntime/core/session/{name}'
        contents['include/'+name]=(args.headers/name).read_bytes() if args.headers else urllib.request.urlopen(url,timeout=45).read()
    contents['LICENSE']=(args.headers/'LICENSE').read_bytes() if args.headers else urllib.request.urlopen(f'https://raw.githubusercontent.com/microsoft/onnxruntime/v{VERSION}/LICENSE',timeout=45).read()
    for name in ('libonnxruntime.so.'+VERSION,'libonnxruntime_providers_shared.so'):
        contents['lib/'+name]=(source/name).read_bytes()
    for relative,data in contents.items():
        path=destination/relative
        if path.exists():assert path.read_bytes()==data,f'Dependency content changed: {path}'
    for relative,data in contents.items():
        path=destination/relative;path.parent.mkdir(parents=True,exist_ok=True)
        if path.exists():continue
        temporary=path.with_name(path.name+'.ainvr-download.tmp');assert not temporary.exists()
        temporary.write_bytes(data);os.replace(temporary,path)
    for name in ('libonnxruntime.so','libonnxruntime.so.1'):
        path=destination/'lib'/name;target='libonnxruntime.so.'+VERSION
        if path.is_symlink():assert os.readlink(path)==target
        else:assert not path.exists();path.symlink_to(target)
    manifest={'version':VERSION,'source':'Microsoft v1.23.2 headers and installed pinned ARM64 wheel','sha256':{p:hashlib.sha256(b).hexdigest() for p,b in contents.items()}}
    path=destination/'manifest.json';data=json.dumps(manifest,indent=2)+'\n'
    if path.exists():assert path.read_text()==data
    else:path.write_text(data)
    print(destination)
if __name__=='__main__':main()
