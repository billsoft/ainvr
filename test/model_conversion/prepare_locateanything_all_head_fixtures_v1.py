"""Freeze eight shared selected decoder rows for every complete vocabulary head.

Calibration fixture parity/global argmax is not fresh whole-model box accuracy.
"""
from pathlib import Path
import json, signal, time, traceback, tarfile
import numpy as np
import torch
import torch.nn.functional as F
from safetensors import safe_open
from hbdk4.compiler import load
from build_locateanything_mixed_decoder_block_v11 import digest, metric

torch.set_num_threads(2)
root=Path('/opt/locate-vocabulary-head-v1')
manifest=json.loads((root/'status.json').read_text())
assert manifest['status']=='full_vocabulary_heads_compiled_bpu_only' and len(manifest['chunks'])==38
out=Path('/work/all-head-board-fixtures-v1.json')
assert not out.exists()
r=dict(status='preparing',started=time.time(),scope='All original vocabulary head chunks on eight common selected-F32 decoder calibration rows; no full-generation acceptance',whole_model_verified=False,chunks=[])
def persist():
    t=out.with_suffix('.json.tmp');t.write_text(json.dumps(r,indent=2));t.replace(out)
signal.signal(signal.SIGALRM,lambda *a:(_ for _ in ()).throw(RuntimeError('900-second reference/archive bound')))
signal.alarm(900);persist()
try:
    captured=Path('/work/selected-decoder-layer-captures-v2')
    meta=json.loads((captured/'status.json').read_text());assert meta['status']=='completed'
    fixtures=[]
    for case in meta['cases'][:8]:
        p=Path(case['directory'])/'block35-call-1/hidden_output.npy'
        fixtures.append(np.load(p)[0,-1:,:].copy())
    assert len(fixtures)==8 and all(x.shape==(1,2048) for x in fixtures)
    source=Path('/opt/locate-original-weights')
    index=json.loads((source/'model.safetensors.index.json').read_text())['weight_map']
    embed='language_model.model.embed_tokens.weight';norm='language_model.model.norm.weight'
    with safe_open(str(source/index[norm]),framework='pt',device='cpu') as sf:
        gamma=sf.get_tensor(norm).float()
    compiler_vectors=[[] for _ in fixtures];original_vectors=[[] for _ in fixtures]
    for i,c in enumerate(manifest['chunks']):
        d=Path(c['directory']);assert digest(d/'model.hbm')==c['hbm_sha256']
        state=json.loads((d/'status.json').read_text());assert state['status']=='compiled_bpu_only' and state['bpu_only']
        with safe_open(str(source/index[embed]),framework='pt',device='cpu') as sf:
            w=sf.get_slice(embed)[c['start']:c['start']+c['count']].float()
        m=load(str(d/'quantized.bc'));f=m[0];files=[]
        refs=d/'board-fixtures-v1';refs.mkdir(exist_ok=False)
        for j,hidden in enumerate(fixtures):
            with torch.inference_mode():
                x=torch.from_numpy(hidden)
                normalized=x*torch.rsqrt(x.square().mean(-1,keepdim=True)+1e-6)*gamma
                raw=F.linear(normalized,w).numpy()
                rounded=torch.from_numpy(raw).bfloat16().float().numpy()
            assert np.isfinite(raw).all() and np.abs(raw).max()<2**17 and np.all((raw==0)|(np.abs(raw)>=2**-24))
            actual=list(f.feed({f.inputs[0].name:hidden}).values())
            error=metric(actual[1],raw);assert error['max_abs']<.001 and error['rel_l2']<1e-5,error
            stem=f'fixture-{j:02d}'
            arrays={'input':hidden,'compiled-formatted':actual[0],'compiled-raw':actual[1],'original-formatted':rounded,'original-raw':raw}
            for suffix,value in arrays.items():np.save(refs/f'{stem}-{suffix}.npy',value)
            compiler_vectors[j].append(actual[0]);original_vectors[j].append(rounded)
            files.append(dict(fixture=j,stem=stem,raw_vs_original=error,formatted_vs_original=metric(actual[0],rounded)))
        (refs/'fixtures.json').write_text(json.dumps(files,indent=2))
        r['chunks'].append(dict(chunk=i,start=c['start'],count=c['count'],directory=str(d),hbm_sha256=c['hbm_sha256'],fixtures=files));persist()
    r['global_argmax']=[]
    for j in range(8):
        candidate=np.concatenate(compiler_vectors[j],axis=-1);reference=np.concatenate(original_vectors[j],axis=-1)
        assert candidate.shape==reference.shape==(1,152681)
        r['global_argmax'].append(dict(fixture=j,compiler_token=int(candidate.argmax()),original_token=int(reference.argmax()),same=int(candidate.argmax())==int(reference.argmax()),formatted_vs_original=metric(candidate,reference)))
    archive=Path('/work/full-vocabulary-heads-v1-board.tar');assert not archive.exists()
    board_manifest=dict(scope=r['scope'],whole_model_verified=False,global_argmax=r['global_argmax'],chunks=[dict(chunk=c['chunk'],start=c['start'],count=c['count'],directory=f"chunk-{c['chunk']:02d}",hbm_sha256=c['hbm_sha256']) for c in r['chunks']])
    mp=Path('/work/full-vocabulary-heads-v1-board-manifest.json');assert not mp.exists();mp.write_text(json.dumps(board_manifest,indent=2))
    with tarfile.open(archive,'w') as tf:
        tf.add(mp,arcname='manifest.json',recursive=False)
        for c in r['chunks']:
            d=Path(c['directory']);prefix=f"chunk-{c['chunk']:02d}"
            for name in ['model.hbm','status.json','ports.json']:
                tf.add(d/name,arcname=prefix+'/'+name,recursive=False)
            tf.add(d/'board-fixtures-v1/fixtures.json',arcname=prefix+'/fixtures.json',recursive=False)
            for q in c['fixtures']:
                for suffix in ['input','compiled-formatted','compiled-raw','original-formatted','original-raw']:
                    name=q['stem']+'-'+suffix+'.npy'
                    tf.add(d/'board-fixtures-v1'/name,arcname=prefix+'/'+name,recursive=False)
    r.update(status='completed',archive=str(archive),archive_bytes=archive.stat().st_size,archive_sha256=digest(archive))
except BaseException:
    r.update(status='failed',error=traceback.format_exc());print(r['error'],flush=True)
finally:
    signal.alarm(0);r['finished']=time.time();persist()
    print(json.dumps({k:v for k,v in r.items() if k not in ['chunks']},indent=2),flush=True)
