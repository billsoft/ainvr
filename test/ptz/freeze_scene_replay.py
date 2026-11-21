"""Pin an isolated probe, projector, scoring code and all labeled JPEGs for one replay."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT=Path(__file__).resolve().parents[2]
BACKEND=ROOT/'srs-web-console/backend'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def freeze(out,probe,previous,independent,live):
    out.mkdir()
    target=out/'pinned'
    target.mkdir()
    for source,name in [(probe,'candidate-probe'),(BACKEND/'src/services/sceneProjection.ts','sceneProjection.ts'),
                        (ROOT/'test/ptz/scene_candidate_replay.mjs','replay.mjs'),
                        (ROOT/'test/ptz/scene_region_oracle.mjs','grade.mjs')]:
        shutil.copy2(source,target/name)
    build="""const fs=require('node:fs'),path=require('node:path'),esbuild=require('esbuild');
const [src,dst]=process.argv.slice(1);
esbuild.buildSync({stdin:{contents:fs.readFileSync(src,'utf8'),loader:'ts',sourcefile:'sceneProjection.ts',
 resolveDir:path.resolve('src/services')},bundle:true,platform:'node',format:'esm',outfile:dst});"""
    subprocess.run(['node','-e',build,str((target/'sceneProjection.ts').resolve()),
                    str((target/'projection.mjs').resolve())],cwd=BACKEND,check=True,timeout=30)
    for name,source in [('original',previous),('subcell',previous/'subcell'),('independent',independent),('live',live)]:
        folder=target/name
        (folder/'fixtures').mkdir(parents=True)
        shutil.copy2(source/'manifest.json',folder/'manifest.json')
        manifest=json.loads((folder/'manifest.json').read_text())
        for case in manifest['cases']:
            for key in ('reference','current'):
                f=case[key]
                if len(f)!=68 or not f.endswith('.jpg') or any(c not in '0123456789abcdef' for c in f[:64]):
                    raise ValueError('Bad fixture digest path')
                dest=folder/'fixtures'/f
                if not dest.exists():
                    shutil.copy2(source/'fixtures'/f,dest)
                    if sha(dest)!=f[:64]:
                        raise ValueError('Input digest mismatch '+f)
    paths=sorted(p for p in target.rglob('*') if p.is_file())
    hashes={p.relative_to(target).as_posix():sha(p) for p in paths}
    lock=target/'sha256.json'
    lock.write_text(json.dumps(hashes,indent=2)+'\n')
    (out/'pin.sha256').write_text(sha(lock)+'  pinned/sha256.json\n')
    for p in paths+[lock]:
        p.chmod(0o555 if p.name=='candidate-probe' else 0o444)
    for p in target.rglob('*'):
        if p.is_dir():
            p.chmod(0o555)
    target.chmod(0o555)
    print('Pinned',len(hashes),'files; lock SHA-256',sha(lock))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['out','probe','previous','independent','live']:
        p.add_argument(name,type=Path)
    a=p.parse_args()
    freeze(a.out,a.probe,a.previous,a.independent,a.live)
