#!/usr/bin/env python3
"""Collect notices for pinned source builds; never include deployment secrets."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

root=Path(__file__).resolve().parents[2]
out=root/'out/gb28181'
target=out/'licenses'
target.mkdir(parents=True,exist_ok=True)
inventory=[]
def collect(name,version,source):
    source=Path(source)
    files=sorted({*source.glob('LICENSE*'),*source.glob('COPYING*')})
    files=[f for f in files if f.is_file()]
    if not files:raise RuntimeError(f'Missing license for {name}')
    for file in files:
        destination=target/(name.replace('/','_')+'-'+file.name)
        shutil.copyfile(file,destination)
        inventory.append({'dependency':name,'version':version,'notice':destination.name,'sha256':hashlib.sha256(destination.read_bytes()).hexdigest()})
collect('Go','1.27.3',out/'go')
collect('FFmpeg','8.1.2',out/'ffmpeg-build/ffmpeg-8.1.2')
for sub in ['', '3rdpart/ZLToolKit','3rdpart/jsoncpp','3rdpart/media-server','3rdpart/pybind11']:
    folder=out/'ZLMediaKit'/sub
    commit=subprocess.check_output(['git','-C',str(folder),'rev-parse','HEAD'],text=True).strip()
    collect('ZLMediaKit/'+sub if sub else 'ZLMediaKit',commit,folder)
raw=subprocess.check_output([str(out/'go/bin/go'),'list','-deps','-json','./cmd/gateway'],cwd=root/'gb28181-service',text=True,timeout=20,env={**os.environ,'GOPROXY':'off','GOTELEMETRY':'off','GOTOOLCHAIN':'local'})
decoder=json.JSONDecoder()
seen=set()
while raw.strip():
    package,end=decoder.raw_decode(raw.lstrip());raw=raw.lstrip()[end:]
    module=package.get('Module')
    if module and not module.get('Main') and module['Path'] not in seen:
        collect(module['Path'],module['Version'],module['Dir']);seen.add(module['Path'])
(target/'inventory.json').write_text(json.dumps(inventory,indent=2)+'\n')
print(f'Collected {len(inventory)} notice files. Preserve corresponding pinned source with distribution.')
